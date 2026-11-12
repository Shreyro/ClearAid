import { audit } from "@/lib/audit";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { publish } from "@/lib/events";
import { recordDonation } from "@/lib/funds";
import { handle, json } from "@/lib/http";
import { fmt, toCents } from "@/lib/money";
import { actorOf, getSession, HttpError, isDonor, ngoMember, requireFundAccess, requireNgo, visibleFunds } from "@/lib/session";
import { movementView } from "@/lib/movements";
import { paypalAccountsOf } from "@/lib/paypal-accounts";
import { entryKey, hasDocument, metaOf, metaView, tagsOf } from "@/lib/entry-meta";

const csvCell = (v: unknown) => {
  if (typeof v === "number") return String(v);
  const s = v === undefined || v === null ? "" : String(v);
  // Quote everything; neutralise spreadsheet formula injection.
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/** One row: the movement, plus (staff only) its tags, documents and whether money out has its paperwork. */
type Row = ReturnType<typeof movementView> & Partial<ReturnType<typeof metaView>> & { hasDocument?: boolean };

/** Every money movement on funds the member can see, newest first. ?format=csv exports. */
export const GET = handle(async (req: Request) => {
  const me = await requireNgo();
  const s = await getSession();
  const db = getDb();
  const q = new URL(req.url).searchParams;
  const all = visibleFunds(db, s);
  const funds = all.filter((f) => !q.get("fund") || f.id === q.get("fund"));
  const titles = new Map(funds.map((f) => [f.id, f.title]));
  const from = q.get("from") ? Date.parse(q.get("from")!) : null;
  const to = q.get("to") ? Date.parse(q.get("to")!) + 86400_000 : null;
  const dir = q.get("direction");
  const text = q.get("q")?.toLowerCase().trim();
  const account = isDonor(s) ? null : q.get("account");
  // Staff only: the NGO's own tags and documents added later; filter by a tag, or money out still missing its paperwork.
  const staff = !isDonor(s);
  const tag = staff ? q.get("tag") : null;
  const missingDocs = staff && q.get("docs") === "missing";
  const meta = metaOf(db);

  const rows = db.ledger
    .filter((e) => titles.has(e.fundId))
    .filter((e) => (from === null || Date.parse(e.ts) >= from) && (to === null || Date.parse(e.ts) < to))
    .map((e): Row => {
      const v = movementView(db, e, titles.get(e.fundId)!);
      if (!staff) return v;
      return { ...v, ...metaView(db, entryKey(e)), hasDocument: hasDocument(db, e, meta[entryKey(e)]) };
    })
    .filter((t) => !tag || Boolean(t.tags?.some((x) => x.id === tag)))
    .filter((t) => !missingDocs || (t.direction === "out" && t.hasDocument === false))
    // Donors don't see other people's contact details.
    .map((t) => (isDonor(s) ? { ...t, counterpartyEmail: undefined, detailHref: t.type === "expense" ? undefined : t.detailHref } : t))
    // Default: money movements only. "all" adds notices (fund opened, request rejected…).
    .filter((t) => (dir === "all" ? true : dir === "in" || dir === "out" || dir === "notice" ? t.direction === dir : t.direction !== "notice"))
    .filter((t) => !account || t.account?.key === account)
    .filter((t) => !text || [t.from, t.to, t.memo, t.paypalRef, t.via, t.typeLabel].some((v) => v?.toLowerCase().includes(text)))
    .sort((a, b) => b.ts.localeCompare(a.ts));

  const totals = {
    in: rows.filter((r) => r.amount > 0).reduce((a, r) => a + r.amount, 0),
    out: rows.filter((r) => r.amount < 0).reduce((a, r) => a - r.amount, 0),
    count: rows.length,
  };

  if (q.get("format") === "csv") {
    mutate((d) => audit(d, { actor: actorOf(me), action: "export.transactions", fundId: q.get("fund") || undefined, summary: `Exported ${rows.length} transactions to CSV` }));
    const head = ["Date", "From", "To", "Amount (USD)", "Direction", "Fund", "Type", "Via", "Counterparty email", "Memo", "Reference", "Ledger #", "Entry hash", ...(staff ? ["Tags", "Documents"] : [])];
    const body = rows.map((r) =>
      [r.ts, r.from, r.to, Number((r.amount / 100).toFixed(2)), r.direction, r.fundTitle, r.typeLabel, r.via, r.counterpartyEmail, r.memo, r.paypalRef, r.seq, r.hash, ...(staff ? [(r.tags ?? []).map((x) => x.name).join("; "), r.docs?.length ?? 0] : [])].map(csvCell).join(","),
    );
    return new Response([head.map(csvCell).join(","), ...body].join("\r\n"), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="clearaid-transactions-${nowIso().slice(0, 10)}.csv"` },
    });
  }
  // Staff can filter by the account money came through; donors don't see the NGO's account list.
  const accounts = isDonor(s)
    ? []
    : [
        ...paypalAccountsOf(db, me.ngoId).map((a) => ({ key: `paypal:${a.id}`, name: a.name, kind: "paypal" as const })),
        ...db.bankAccounts.filter((a) => a.ngoId === me.ngoId).map((a) => ({ key: `bank:${a.id}`, name: a.name, kind: "bank" as const })),
      ];
  const tags = staff ? tagsOf(db).filter((t) => t.ngoId === me.ngoId).map((t) => ({ id: t.id, name: t.name, color: t.color })) : [];
  return json({ transactions: rows.slice(0, 2000), totals, funds: all.map((f) => ({ id: f.id, title: f.title })), accounts, tags });
});

/**
 * Record money received outside the PayPal checkout (bank transfer, cheque,
 * cash, grant). Admins, or staff assigned to the fund.
 */
export const POST = handle(async (req: Request) => {
  const me = await requireNgo();
  const b = (await req.json()) as { fundId?: string; amountUsd?: number; payerName?: string; payerEmail?: string; method?: string; reference?: string; receivedAt?: string };
  const { fund } = await requireFundAccess(b.fundId ?? "");
  const m = ngoMember(me.id)!;
  if (m.role !== "admin" && !fund.assignees.includes(m.id)) throw new HttpError(403, "Only admins or this fund's approvers can record transactions");
  if (fund.status === "closed") throw new HttpError(400, "This fund is closed");
  const amount = toCents(Number(b.amountUsd));
  if (!(amount > 0) || amount > 100_000_000) throw new HttpError(400, "Enter an amount between $0.01 and $1,000,000");
  const payerName = b.payerName?.trim().slice(0, 80);
  if (!payerName) throw new HttpError(400, "Who sent the money?");
  const email = b.payerEmail?.trim();
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, "That email doesn't look right");
  const METHODS = ["bank_transfer", "cheque", "cash", "grant", "other"];
  const method = METHODS.includes(b.method ?? "") ? b.method! : "other";
  const reference = b.reference?.trim().slice(0, 60);
  if (!reference) throw new HttpError(400, "Add a reference (bank transaction ID, cheque number or receipt number)");
  const receivedAt = b.receivedAt && !Number.isNaN(Date.parse(b.receivedAt)) ? new Date(Math.min(Date.parse(b.receivedAt), Date.now())).toISOString() : nowIso();

  const label = method.replace("_", " ");
  const res = mutate((db) => {
    const ref = `MANUAL-${newId("rx").slice(3).toUpperCase()}`;
    const r = recordDonation(db, {
      fundId: fund.id,
      amount,
      captureId: ref,
      orderId: reference,
      live: false,
      donorEmail: email || undefined,
      donorName: payerName,
      showName: true,
      at: receivedAt,
      memo: `Received by ${label} (ref ${reference}), recorded by ${m.name}`,
    });
    audit(db, {
      actor: actorOf(m),
      action: "transaction.recorded",
      fundId: fund.id,
      targetId: r.donation.id,
      summary: `Recorded ${fmt(amount)} received from ${payerName} by ${label} (ref ${reference})`,
      meta: { amount, method, reference },
    });
    return r;
  });
  publish({ kind: "ledger", fundId: fund.id, entry: res.entry });
  return json({ ok: true, entry: res.entry });
});
