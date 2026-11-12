import { buildFlow } from "../flow";
import { fundStats } from "../funds";
import { fmt } from "../money";
import { movementView } from "../movements";
import { PAYMENT_METHODS } from "../payments";
import { categoryLabel, type DB, type Fund } from "../types";

/**
 * Everything recorded in ClearAid, as short passages the Copilot can search.
 *
 * Passages are grouped into one index per fund and audience:
 *   f:<fundId>:staff   full detail (raw purposes, receipt line items, emails)
 *   f:<fundId>:public  what a donor may read (the same redaction as the screens)
 *   ngo:<ngoId>:untraced  bank lines not on any fund yet (staff only)
 *
 * Which indexes a person may search is decided in ./scope.ts, never here.
 */

export type Doc = { id: string; text: string; meta: { fundId?: string; kind: string; date?: string; href?: string } };
export type Audience = "staff" | "public";

export const fundIndex = (fundId: string, audience: Audience) => `f:${fundId}:${audience}`;
export const untracedIndex = (ngoId: string) => `ngo:${ngoId}:untraced`;

const day = (iso: string) => iso.slice(0, 10);
const money = (cents: number) => fmt(Math.abs(cents));
/** Like money, but a minus sign when below zero (a fund that spent more than it holds). */
const signed = (cents: number) => `${cents < 0 ? "-" : ""}${money(cents)}`;

function fundProfile(db: DB, f: Fund): Doc {
  const ngo = db.ngos.find((n) => n.id === f.ngoId);
  const needs = f.needs.map((n) => `${n.item} (${n.unit}, ${money(n.unitCost)} each, ${n.fulfilledQty} of ${n.targetQty} delivered)`).join("; ");
  const caps = Object.entries(f.policy.categoryCaps ?? {})
    .map(([c, pct]) => `${categoryLabel(c as never)} ≤ ${pct}%`)
    .join(", ");
  return {
    id: `fund:${f.id}`,
    meta: { fundId: f.id, kind: "fund", href: `/funds/${f.slug}` },
    text: [
      `Fund "${f.title}" run by ${ngo?.name ?? "the NGO"}. Status: ${f.status}. Region: ${f.region}. Disaster: ${f.disaster}.`,
      `Started ${day(f.startedAt)}. Goal ${money(f.goal)}. Tracking codes: ${(f.trackingCodes ?? []).map((c) => `#${c}`).join(", ") || "none"}.`,
      f.description,
      needs && `Needs: ${needs}.`,
      caps && `Spending caps: ${caps}.`,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function ledgerDocs(db: DB, f: Fund, audience: Audience): Doc[] {
  return db.ledger
    .filter((e) => e.fundId === f.id)
    .map((e) => {
      const m = movementView(db, e, f.title);
      const dir = m.direction === "in" ? "Money in" : m.direction === "out" ? "Money out" : "Notice";
      const amount = m.amount ? ` ${m.amount > 0 ? "+" : "−"}${money(m.amount)}` : "";
      const email = audience === "staff" && m.counterpartyEmail ? ` (${m.counterpartyEmail})` : "";
      const fromTo = m.direction === "notice" ? "" : ` from ${m.from}${m.direction === "in" ? email : ""} to ${m.to}${m.direction === "out" ? email : ""}.`;
      return {
        id: `led:${f.id}:${e.seq}`,
        meta: { fundId: f.id, kind: "ledger", date: day(e.ts), href: m.detailHref && !m.detailHref.startsWith("/api/") ? m.detailHref : undefined },
        text: `${day(e.ts)} · ${f.title} · ${dir}${amount} · ${m.typeLabel}${m.via ? ` via ${m.via}` : ""}.${fromTo} Memo: ${m.memo}${m.paypalRef ? ` · Ref ${m.paypalRef}` : ""} · Ledger #${e.seq}`,
      };
    });
}

function bankDocs(db: DB, f: Fund, audience: Audience): Doc[] {
  const out: Doc[] = [];
  for (const t of db.bankTxns) {
    const a = t.allocations.find((x) => x.fundId === f.id);
    if (!a) continue;
    const acc = db.bankAccounts.find((x) => x.id === t.accountId);
    const parts = [
      `${t.date} · ${f.title} · Bank ${t.amount < 0 ? (t.isFee ? "fee" : "payment") : "receipt"} ${money(a.amount)}${t.allocations.length > 1 ? ` (split; line total ${money(t.amount)})` : ""} on ${acc?.name ?? "a bank account"}.`,
      `Description: ${t.description}${t.counterparty ? ` · Counterparty: ${t.counterparty}` : ""}.`,
      a.category ? `Category: ${categoryLabel(a.category)}.` : "",
      a.code ? `Tagged by code #${a.code}.` : t.reason ? `Tagged by ${t.taggedByName ?? "staff"}: ${t.reason}.` : "",
    ];
    // Receipts are private files: their contents go to staff only.
    if (audience === "staff") {
      for (const r of t.receipts ?? []) {
        const x = r.extraction;
        if (!x) continue;
        const items = x.lineItems.map((li) => `${li.description}${li.amount != null ? ` ${li.amount}` : ""}`).join("; ");
        parts.push(`Receipt from ${x.supplier ?? "unknown supplier"}${x.invoiceNumber ? `, invoice ${x.invoiceNumber}` : ""}${x.date ? `, dated ${x.date}` : ""}${x.total != null ? `, total ${x.currency ?? ""} ${x.total}` : ""}${items ? `. Items: ${items}` : ""}.`);
      }
    } else if (t.receipts?.length) parts.push("A receipt is on file.");
    out.push({ id: `bank:${t.id}:${f.id}`, meta: { fundId: f.id, kind: "bank", date: t.date }, text: parts.filter(Boolean).join(" ") });
  }
  return out;
}

function paymentDocs(db: DB, f: Fund, audience: Audience): Doc[] {
  return (db.payments ?? [])
    .filter((p) => p.fundId === f.id)
    .map((p) => {
      const staff = audience === "staff";
      const status = { awaiting_bank: "waiting for its bank line", matched: "matched to its bank line", no_bank: "no bank line expected", void: `voided (${p.voidReason ?? ""})` }[p.status];
      const parts = [
        `${p.date} · ${f.title} · Declared payment ${money(p.amount)} to ${staff ? p.payee : p.publicPayee} by ${PAYMENT_METHODS[p.method].toLowerCase()}.`,
        `For: ${staff ? p.description : p.publicDescription}.`,
        p.category ? `Category: ${categoryLabel(p.category)}.` : "",
        p.invoiceNumber ? `Invoice ${p.invoiceNumber}.` : "",
        `Status: ${status}.`,
        staff ? `Recorded by ${p.byName}.` : "",
      ];
      const x = staff ? p.receipt?.extraction : undefined;
      if (x?.lineItems.length) parts.push(`Receipt items: ${x.lineItems.map((li) => `${li.description}${li.amount != null ? ` ${li.amount}` : ""}`).join("; ")}.`);
      return { id: `pay:${p.id}`, meta: { fundId: f.id, kind: "payment", date: p.date }, text: parts.filter(Boolean).join(" ") };
    });
}

function withdrawalDocs(db: DB, f: Fund, audience: Audience): Doc[] {
  return db.withdrawals
    .filter((w) => w.fundId === f.id && (audience === "staff" || w.status !== "auditing"))
    .map((w) => {
      const v = db.vendors.find((x) => x.id === w.vendorId);
      const parts = [
        `${day(w.createdAt)} · ${f.title} · Payment request ${w.id} for ${money(w.amount)} to ${v?.name ?? "a vendor"}${v?.location ? ` (${v.location})` : ""}. Category: ${categoryLabel(w.category)}. Status: ${w.status}${w.paidAt ? `, paid ${day(w.paidAt)}` : ""}.`,
        `Purpose: ${audience === "staff" ? w.purposeRaw : w.purposePublic}.`,
        w.quantity ? `Quantity: ${w.quantity}.` : "",
        w.beneficiaries ? `Beneficiaries: ${w.beneficiaries}.` : "",
        w.location ? `Location: ${w.location}.` : "",
        w.audit ? `Audit (${w.audit.verdict}, risk ${w.audit.riskScore}): ${w.audit.summary}` : "",
      ];
      return { id: `wd:${w.id}`, meta: { fundId: f.id, kind: "request", date: day(w.createdAt), href: `/spend/${w.id}` }, text: parts.filter(Boolean).join(" ") };
    });
}

function untracedDocs(db: DB, ngoId: string): Doc[] {
  const accounts = new Map(db.bankAccounts.filter((a) => a.ngoId === ngoId).map((a) => [a.id, a]));
  return db.bankTxns
    .filter((t) => accounts.has(t.accountId) && (t.status === "untagged" || t.status === "fee_unallocated"))
    .map((t) => ({
      id: `untraced:${t.id}`,
      meta: { kind: "untraced", date: t.date, href: `/untagged?status=all&q=${t.id}` },
      text: `${t.date} · Not on any fund yet · Bank ${t.amount < 0 ? (t.isFee ? "fee" : "payment") : "receipt"} ${money(t.amount)} on ${accounts.get(t.accountId)!.name}. Description: ${t.description}${t.counterparty ? ` · Counterparty: ${t.counterparty}` : ""}. Why: ${t.untaggedReason ?? "no tracking code"}.`,
    }));
}

/** Every index, with its passages. Rebuilt in full; the rag service only re-embeds text that changed. */
export function buildIndexes(db: DB): Record<string, Doc[]> {
  const out: Record<string, Doc[]> = {};
  for (const f of db.funds) {
    for (const audience of ["staff", "public"] as const) {
      out[fundIndex(f.id, audience)] = [fundProfile(db, f), ...ledgerDocs(db, f, audience), ...bankDocs(db, f, audience), ...paymentDocs(db, f, audience), ...withdrawalDocs(db, f, audience)];
    }
  }
  for (const n of db.ngos) out[untracedIndex(n.id)] = untracedDocs(db, n.id);
  return out;
}

/**
 * Exact figures for one fund, worked out from the ledger when the question is
 * asked (search finds passages; totals have to be computed, not guessed).
 */
const pct = (part: number, whole: number) => `${((part / whole) * 100).toFixed(1)}%`;

/** Money in and spent per calendar month (UTC) from the fund's ledger, same rules as fundStats. */
function monthly(db: DB, f: Fund) {
  const m = new Map<string, { in: number; out: number }>();
  for (const l of db.ledger.filter((x) => x.fundId === f.id)) {
    const inn = l.type === "donation" || l.type === "carry_forward_in" ? Math.abs(l.amount) : l.type === "bank_in" ? l.amount : 0;
    const out = l.type === "withdrawal" ? Math.abs(l.amount) : l.type === "bank_out" || l.type === "expense" ? -l.amount : 0;
    if (!inn && !out) continue;
    const k = l.ts.slice(0, 7);
    const e = m.get(k) ?? { in: 0, out: 0 };
    e.in += inn;
    e.out += out;
    m.set(k, e);
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Who is ahead of whom across funds, worked out here so the model never compares or ranks numbers itself. */
export function fundRankings(db: DB, funds: Fund[]) {
  if (funds.length < 2) return "";
  const rows = funds.map((f) => ({ f, s: fundStats(db, f) }));
  const list = (key: (r: (typeof rows)[number]) => number, text: (r: (typeof rows)[number]) => string) =>
    [...rows].sort((a, b) => key(b) - key(a)).map((r, i) => `${i + 1}. ${r.f.title} ${text(r)}`).join("; ");
  return [
    `RANKED, highest first. MONEY RAISED: ${list((r) => r.s.raised, (r) => money(r.s.raised))}`,
    `MONEY SPENT: ${list((r) => r.s.spent, (r) => money(r.s.spent))}`,
    `BALANCE STILL HELD: ${list((r) => r.s.balance, (r) => signed(r.s.balance))}`,
    `PROGRESS TO GOAL (raised): ${list((r) => (r.f.goal > 0 ? r.s.raised / r.f.goal : 0), (r) => (r.f.goal > 0 ? pct(r.s.raised, r.f.goal) : "no goal"))}`,
    `NUMBER OF DONORS: ${list((r) => r.s.donors, (r) => String(r.s.donors))}`,
  ].join("\n");
}

/** Counts and totals of bank lines that aren't on a fund yet. */
export function untracedSummary(db: DB, ngoId: string) {
  const accounts = new Set(db.bankAccounts.filter((a) => a.ngoId === ngoId).map((a) => a.id));
  const lines = db.bankTxns.filter((t) => accounts.has(t.accountId) && (t.status === "untagged" || t.status === "fee_unallocated"));
  const total = (xs: typeof lines) => money(xs.reduce((a, t) => a + Math.abs(t.amount), 0));
  const fees = lines.filter((t) => t.isFee);
  const rec = lines.filter((t) => !t.isFee && t.amount >= 0);
  const pay = lines.filter((t) => !t.isFee && t.amount < 0);
  return `BANK LINES NOT ON ANY FUND: ${lines.length} in all. Receipts: ${rec.length} totalling ${total(rec)}. Payments: ${pay.length} totalling ${total(pay)}. Bank fees: ${fees.length} totalling ${total(fees)}.`;
}

/** Largest payees and sources for this month and last month, so period questions copy real figures. */
function periodParties(db: DB, f: Fund) {
  const now = new Date();
  const cur = now.toISOString().slice(0, 7);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const line = (label: string, month: string, kind: "payees" | "sources") => {
    const flow = buildFlow(db, [f], { ngoId: f.ngoId, includeUntraced: false, month });
    const rows = flow[kind].slice(0, 5).map((p) => `${p.name} ${money(p.total)}`);
    return `${label} (${month}): ${rows.join("; ") || "none"}`;
  };
  return [line("PAYEES THIS MONTH", cur, "payees"), line("PAYEES LAST MONTH", prev, "payees"), line("SOURCES THIS MONTH", cur, "sources"), line("SOURCES LAST MONTH", prev, "sources")];
}

export function fundSummary(db: DB, f: Fund, audience: Audience) {
  const s = fundStats(db, f);
  const flow = buildFlow(db, [f], { ngoId: f.ngoId, includeUntraced: false, payeeLimit: 12 });
  const label = new Map(flow.category.nodes.map((n) => [n.id, n.label]));
  const byCategory = flow.category.links
    .filter((l) => l.source === `fund:${f.id}` && l.target !== "dst:balance")
    .sort((a, b) => b.value - a.value)
    .map((l) => `${label.get(l.target) ?? l.target} ${money(l.value)}`)
    .join("; ");
  // Money in by channel (PayPal, each bank account, recorded by staff, carried in).
  const byChannel = flow.category.links
    .filter((l) => l.target === `fund:${f.id}`)
    .sort((a, b) => b.value - a.value)
    .map((l) => `${label.get(l.source) ?? l.source} ${money(l.value)}`)
    .join("; ");
  const byCategoryTop = flow.category.links
    .filter((l) => l.source === `fund:${f.id}` && l.target !== "dst:balance")
    .sort((a, b) => b.value - a.value)
    .slice(0, 1)
    .map((l) => `${label.get(l.target) ?? l.target} ${money(l.value)}`)[0];
  const party = (p: { name: string; total: number; count: number; via: string }) => `  - ${p.name}: ${money(p.total)} in ${p.count} payment${p.count === 1 ? "" : "s"} (${p.via})`;
  const waiting = (db.payments ?? []).filter((p) => p.fundId === f.id && p.status === "awaiting_bank").length;
  // Plain labelled lines: a small local model copies figures reliably but adds them up badly.
  return [
    `=== ${f.title} (status: ${f.status}; tracking codes: ${(f.trackingCodes ?? []).map((c) => `#${c}`).join(" ") || "none"}) ===`,
    `TOTAL MONEY IN: ${money(s.raised)}${byChannel ? ` (by channel: ${byChannel})` : ""}`,
    `TOTAL MONEY OUT (spent): ${money(s.spent)}${byCategory ? ` (by category: ${byCategory})` : ""}`,
    `REFUNDED TO DONORS: ${money(s.refunded)}`,
    `CARRIED TO OTHER FUNDS: ${money(s.carriedOut)}`,
    `BALANCE STILL HELD: ${signed(s.balance)}${s.balance < 0 ? " (overspent: the fund has spent more than it received)" : ""} (goal ${money(f.goal)})`,
    // Worked out here so the model copies the percentages instead of dividing.
    f.goal > 0 ? `PROGRESS TO GOAL: raised ${money(s.raised)} of the ${money(f.goal)} goal (${pct(s.raised, f.goal)}); the balance still held, ${signed(s.balance)}, is ${pct(s.balance, f.goal)} of the goal` : "",
    `LIFECYCLE: ${f.status === "closing" ? `CLOSING: the fund is winding down${f.closingStartedAt ? ` (started ${f.closingStartedAt.slice(0, 10)})` : ""}` : f.status === "closed" ? "CLOSED" : "ACTIVE: still open and receiving or spending money"}`,
    `NUMBER OF DONORS: ${s.donors}`,
    ...(() => {
      const months = monthly(db, f).slice(-6);
      if (!months.length) return [];
      const now = new Date();
      const cur = now.toISOString().slice(0, 7);
      const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
      const at = (k: string) => months.find(([m]) => m === k)?.[1];
      const one = (label: string, k: string) => `${label} (${k}): ${at(k) ? `money in ${money(at(k)!.in)}, spent ${money(at(k)!.out)}` : "no money came in or went out"}`;
      return [`BY MONTH: ${months.map(([k, v]) => `${k} in ${money(v.in)}, spent ${money(v.out)}`).join("; ")}`, one("THIS MONTH", cur), one("LAST MONTH", prev)];
    })(),
    byCategoryTop ? `BIGGEST SPENDING CATEGORY: ${byCategoryTop}` : "",
    flow.sources.length ? `LARGEST SOURCES OF MONEY IN:\n${flow.sources.slice(0, 8).map(party).join("\n")}` : "",
    flow.payees.length ? `LARGEST PAYEES (MONEY OUT):\n${flow.payees.slice(0, 10).map(party).join("\n")}` : "",
    ...periodParties(db, f),
    audience === "staff" && waiting ? `DECLARED PAYMENTS STILL WAITING FOR THEIR BANK LINE: ${waiting}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
