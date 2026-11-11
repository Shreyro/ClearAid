import { audit } from "@/lib/audit";
import { reclassify, statementAnonymiser } from "@/lib/banking";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { fmt, toCents } from "@/lib/money";
import { bankCandidates, expectsBankLine, linkPayment, PAYMENT_METHODS, paymentsOf, paymentView, postPayment, reversePayment } from "@/lib/payments";
import { actorOf, HttpError, requireFundAccess, requireNgo, type SignedInMember } from "@/lib/session";
import { CATEGORIES, type Category, type DB, type DeclaredPayment, type LedgerEntry, type PaymentMethod } from "@/lib/types";
import { announce } from "../bank/shared";

const mayRecord = (db: DB, me: SignedInMember, fundId: string) => me.role === "admin" || Boolean(db.funds.find((f) => f.id === fundId)?.assignees.includes(me.id));

/** Declared payments on the funds this member can record to, newest first. */
export const GET = handle(async (req: Request) => {
  const me = await requireNgo();
  const db = getDb();
  const status = new URL(req.url).searchParams.get("status");
  const rows = paymentsOf(db)
    .filter((p) => p.ngoId === me.ngoId && mayRecord(db, me, p.fundId))
    .filter((p) => !status || p.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 500)
    .map((p) => paymentView(db, p));
  return json({ payments: rows, methods: PAYMENT_METHODS });
});

type Body =
  | {
      action: "create";
      fileId?: string;
      fundId?: string;
      category?: string;
      amountUsd?: number;
      payee?: string;
      date?: string;
      method?: string;
      invoiceNumber?: string;
      description?: string;
      /** The person confirmed it isn't the bank line that's already on a fund. */
      force?: boolean;
    }
  | { action: "unlink"; id?: string }
  /** Add the receipt or invoice to a payment recorded without one. */
  | { action: "attach"; id?: string; fileId?: string }
  | { action: "void"; id?: string; reason?: string };

/**
 * Step 2: record the payment the person checked. It's posted to the fund's
 * ledger now; a bank payment is matched to its bank line (now if it's already
 * imported, otherwise when it arrives) so it's never counted twice.
 */
export const POST = handle(async (req: Request) => {
  const me = await requireNgo();
  const b = (await req.json()) as Body;
  const actor = actorOf(me);

  if (b.action === "create") {
    const { fund } = await requireFundAccess(b.fundId ?? "");
    if (!mayRecord(getDb(), me, fund.id)) throw new HttpError(403, "Only admins or this fund's approvers can record payments from it");
    if (fund.status === "closed") throw new HttpError(400, "This fund is closed");
    const amount = toCents(Number(b.amountUsd));
    if (!(amount > 0) || amount > 100_000_000) throw new HttpError(400, "Enter an amount between $0.01 and $1,000,000");
    const payee = b.payee?.trim().slice(0, 120);
    if (!payee) throw new HttpError(400, "Who was paid?");
    const description = b.description?.trim().slice(0, 200);
    if (!description || description.length < 3) throw new HttpError(400, "Say what it was for (e.g. 200 tarpaulins for Kendrapara shelters)");
    if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || Number.isNaN(Date.parse(b.date))) throw new HttpError(400, "Enter the payment date");
    if (b.date > nowIso().slice(0, 10)) throw new HttpError(400, "The payment date can't be in the future");
    const method = (b.method && b.method in PAYMENT_METHODS ? b.method : "") as PaymentMethod;
    if (!method) throw new HttpError(400, "How was it paid?");
    const category = b.category ? (CATEGORIES.find((c) => c.id === b.category)?.id as Category | undefined) : undefined;
    if (b.category && !category) throw new HttpError(400, "Unknown category");
    const invoiceNumber = b.invoiceNumber?.trim().slice(0, 60) || undefined;

    const res = mutate((db) => {
      // The receipt is optional (entered by hand); it can be attached later.
      const file = b.fileId ? receiptFile(db, me.ngoId, b.fileId) : undefined;
      const scan = file?.scan;

      // The ledger is readable by donors, so a private person's name is replaced, the same way bank lines are.
      const shown = statementAnonymiser(db, me.ngoId)({ date: b.date!, amount: -amount, description, counterparty: payee });
      const p: DeclaredPayment = {
        id: newId("pay"),
        ngoId: me.ngoId,
        fundId: fund.id,
        category,
        amount,
        payee,
        date: b.date!,
        method,
        invoiceNumber,
        description,
        publicPayee: shown.counterparty || payee,
        publicDescription: shown.description,
        ...(file ? { receipt: { fileId: file.id, engine: scan?.engine ?? "none", extraction: scan?.extraction, note: scan?.note, edited: editedFields(scan?.extraction, { amount, payee, date: b.date!, invoiceNumber }) } } : {}),
        status: expectsBankLine(method) ? "awaiting_bank" : "no_bank",
        byId: me.id,
        byName: me.name,
        createdAt: nowIso(),
      };

      // Is the bank line already here? An untagged one becomes this payment's bank side.
      // One that's already on a fund means this payment is probably already counted.
      if (expectsBankLine(method)) {
        const cands = bankCandidates(db, me.ngoId, p);
        const free = cands.find((c) => c.t.status === "untagged" && !c.t.pending);
        const taken = cands.find((c) => c.t.allocations.length || c.t.pending);
        if (!free && taken && !b.force) {
          const t = taken.t;
          const where = t.allocations.map((a) => db.funds.find((f) => f.id === a.fundId)?.title).filter(Boolean).join(", ") || "a fund (waiting for approval)";
          throw new HttpError(409, `A bank payment of ${fmt(amount)} on ${t.date} ("${t.description.slice(0, 60)}") is already on ${where}. If that's this payment, attach the receipt to that line on the Untagged page instead. If it's a different payment, record it anyway.`);
        }
        paymentsOf(db).push(p);
        const entry = postPayment(db, p);
        if (free) linkPayment(db, p, free.t, actor, "on_record");
        audit(db, {
          actor,
          action: "payment.recorded",
          fundId: fund.id,
          targetId: p.id,
          summary: `Declared a ${fmt(amount)} ${PAYMENT_METHODS[method].toLowerCase()} payment to ${p.publicPayee} from ${fund.title}: ${p.publicDescription}${p.receipt?.edited?.length ? ` (changed from the receipt: ${p.receipt.edited.join(", ")})` : ""}${file ? "" : " · entered by hand, no receipt attached yet"}${free ? " · matched to its bank line" : " · waiting for its bank line"}`,
          meta: { amount, method, ...(file ? { sha256: file.sha256 } : {}), ...(invoiceNumber ? { invoiceNumber } : {}) },
        });
        return { p, entry };
      }
      paymentsOf(db).push(p);
      const entry = postPayment(db, p);
      audit(db, {
        actor,
        action: "payment.recorded",
        fundId: fund.id,
        targetId: p.id,
        summary: `Declared a ${fmt(amount)} ${PAYMENT_METHODS[method].toLowerCase()} payment to ${p.publicPayee} from ${fund.title}: ${p.publicDescription}${p.receipt?.edited?.length ? ` (changed from the receipt: ${p.receipt.edited.join(", ")})` : ""}${file ? "" : " · entered by hand, no receipt attached yet"}`,
        meta: { amount, method, ...(file ? { sha256: file.sha256 } : {}), ...(invoiceNumber ? { invoiceNumber } : {}) },
      });
      return { p, entry };
    });
    announce([res.entry]);
    const view = paymentView(getDb(), res.p);
    return json({
      ok: true,
      payment: view,
      message:
        view.status === "matched"
          ? `Recorded and matched to its bank line (${view.bankLine?.date})`
          : view.status === "awaiting_bank"
            ? "Recorded. It'll be matched when its bank line comes in, so it isn't counted twice."
            : "Recorded",
    });
  }

  if (b.action === "attach") {
    const message = mutate((db) => {
      const p = paymentsOf(db).find((x) => x.id === b.id && x.ngoId === me.ngoId);
      if (!p || !mayRecord(db, me, p.fundId)) throw new HttpError(404, "Payment not found");
      if (p.status === "void") throw new HttpError(400, "This payment was voided");
      if (p.receipt) throw new HttpError(400, "This payment already has its receipt");
      const file = receiptFile(db, me.ngoId, b.fileId ?? "");
      const scan = file.scan;
      p.receipt = { fileId: file.id, engine: scan?.engine ?? "none", extraction: scan?.extraction, note: scan?.note, edited: editedFields(scan?.extraction, { amount: p.amount, payee: p.payee, date: p.date, invoiceNumber: p.invoiceNumber }) };
      const differs = p.receipt.edited?.length ? ` The receipt differs on: ${p.receipt.edited.join(", ")}.` : "";
      audit(db, {
        actor,
        action: "payment.receipt_attached",
        fundId: p.fundId,
        targetId: p.id,
        summary: `Attached the receipt to the ${fmt(p.amount)} payment to ${p.publicPayee} (${p.date}), which was entered by hand.${differs}`,
        meta: { amount: p.amount, sha256: file.sha256 },
      });
      return `Receipt attached.${differs}`;
    });
    return json({ ok: true, message });
  }

  if (b.action === "unlink" || b.action === "void") {
    const out = mutate((db) => {
      const p = paymentsOf(db).find((x) => x.id === b.id && x.ngoId === me.ngoId);
      if (!p || !mayRecord(db, me, p.fundId)) throw new HttpError(404, "Payment not found");
      if (p.status === "void") throw new HttpError(400, "This payment was already voided");
      const entries: LedgerEntry[] = [];
      const unlink = () => {
        const t = db.bankTxns.find((x) => x.id === p.bankTxnId);
        p.bankTxnId = undefined;
        p.matchedAt = undefined;
        p.matchedBy = undefined;
        // The line goes back through tracking-code matching, or into the Untagged queue.
        if (t) entries.push(...reclassify(db, t));
        return t;
      };

      if (b.action === "unlink") {
        if (p.status !== "matched") throw new HttpError(400, "This payment isn't matched to a bank line");
        const t = unlink();
        p.status = "awaiting_bank";
        audit(db, { actor, action: "payment.unlinked", fundId: p.fundId, targetId: p.id, summary: `Unlinked the ${fmt(p.amount)} payment to ${p.publicPayee} from bank line ${t?.date ?? ""} "${t?.description.slice(0, 60) ?? ""}"; the line went back to ${t?.status === "untagged" ? "the Untagged queue" : "tracking-code matching"}`, meta: { bankTxnId: t?.id ?? "" } });
        return { entries, message: "Unlinked. The bank line is back in the Untagged queue (or tagged by its code)." };
      }

      const reason = b.reason?.trim();
      if (!reason || reason.length < 3) throw new HttpError(400, "Give a reason (it goes on the ledger and in the audit log)");
      if (me.role !== "admin" && p.byId !== me.id) throw new HttpError(403, "Only the person who recorded it or an admin can void it");
      if (p.status === "matched") unlink();
      entries.push(reversePayment(db, p, reason.slice(0, 120)));
      p.status = "void";
      p.voidedAt = nowIso();
      p.voidedBy = me.name;
      p.voidReason = reason.slice(0, 200);
      audit(db, { actor, action: "payment.voided", fundId: p.fundId, targetId: p.id, summary: `Voided the ${fmt(p.amount)} payment to ${p.publicPayee}: ${reason.slice(0, 120)}. The money was posted back to the fund.`, meta: { amount: p.amount } });
      return { entries, message: "Voided. The amount was posted back to the fund." };
    });
    announce(out.entries);
    return json({ ok: true, message: out.message });
  }
  throw new HttpError(400, "Unknown action");
});

/** An uploaded receipt of this NGO that no other live payment uses yet. */
function receiptFile(db: DB, ngoId: string, fileId: string) {
  const file = db.files.find((f) => f.id === fileId && f.kind === "receipt" && !f.public && f.scan?.ngoId === ngoId);
  if (!file) throw new HttpError(400, "Upload the receipt or invoice first");
  if (paymentsOf(db).some((p) => p.receipt?.fileId === file.id && p.status !== "void")) throw new HttpError(409, "This receipt was already used for another payment");
  return file;
}

function editedFields(x: NonNullable<DeclaredPayment["receipt"]>["extraction"] | undefined, got: { amount: number; payee: string; date: string; invoiceNumber?: string }) {
  if (!x) return undefined;
  const out: string[] = [];
  if (x.total != null && Math.round(x.total * 100) !== got.amount) out.push("amount");
  if (x.supplier && x.supplier.trim().toLowerCase() !== got.payee.toLowerCase()) out.push("payee");
  if (x.date && x.date !== got.date) out.push("date");
  if (x.invoiceNumber && x.invoiceNumber !== (got.invoiceNumber ?? "")) out.push("invoice number");
  return out.length ? out : undefined;
}
