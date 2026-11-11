import { audit, SYSTEM_ACTOR } from "./audit";
import { nowIso } from "./db";
import { appendLedger } from "./ledger";
import { fmt } from "./money";
import { categoryLabel, type BankTxn, type DB, type DeclaredPayment, type LedgerEntry, type PaymentMethod } from "./types";

/**
 * Payments declared by hand from a receipt or invoice.
 *
 * A declared payment is posted to its fund's ledger as soon as it's recorded
 * (type "expense"). If it was paid from a bank account it then waits for its
 * bank line. When that line is imported it becomes the bank side of the
 * payment ("matched") instead of being posted again, so the money is counted
 * once. Cash payments never get a bank line.
 *
 * Kept free of imports from ./banking so the statement import can call it.
 */

export const paymentsOf = (db: DB) => (db.payments ??= []);

export const PAYMENT_METHODS: Record<PaymentMethod, string> = {
  bank_transfer: "Bank transfer",
  card: "Card",
  cheque: "Cheque",
  cash: "Cash",
  other: "Other (no bank line)",
};

/** Methods that leave the NGO's bank account, so a bank line should follow. */
export const expectsBankLine = (m: PaymentMethod) => m === "bank_transfer" || m === "card" || m === "cheque";

const DAY = 86400_000;
const dayDiff = (later: string, earlier: string) => Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY);

const STOP = new Set(["THE", "AND", "LTD", "PVT", "LLC", "INC", "CORP", "LIMITED", "NEFT", "RTGS", "IMPS", "UPI", "ACH", "WIRE", "POS", "CHQ"]);
const words = (s: string) => new Set(s.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** Bank lines can post a few days before the receipt date (card holds) and up to three weeks after (cheques). */
export const MATCH_WINDOW = { before: 3, after: 21 };

/**
 * Could this bank line be the bank side of the payment? Fixed rule, no AI:
 * the amount must be exactly the same and the date within the window. Among
 * several, the payee name on the line and the closest date win.
 */
export function fit(p: { amount: number; date: string; payee: string }, t: BankTxn) {
  if (t.amount >= 0 || t.isFee || Math.abs(t.amount) !== p.amount) return null;
  const days = dayDiff(t.date, p.date);
  if (days < -MATCH_WINDOW.before || days > MATCH_WINDOW.after) return null;
  const want = words(p.payee);
  const have = words(`${t.counterparty ?? ""} ${t.description}`);
  const overlap = want.size ? [...want].filter((w) => have.has(w)).length / want.size : 0;
  return { days, overlap, score: overlap * 10 - Math.abs(days) * 0.1 };
}

/** Bank lines of this NGO that could be the payment's bank side, best first. */
export function bankCandidates(db: DB, ngoId: string, p: { amount: number; date: string; payee: string }) {
  const accounts = new Set(db.bankAccounts.filter((a) => a.ngoId === ngoId).map((a) => a.id));
  return db.bankTxns
    .filter((t) => accounts.has(t.accountId) && !t.paymentId)
    .map((t) => ({ t, f: fit(p, t) }))
    .filter((x): x is { t: BankTxn; f: NonNullable<ReturnType<typeof fit>> } => Boolean(x.f))
    .sort((a, b) => b.f.score - a.f.score);
}

/** Make the bank line the bank side of the payment. Nothing new is posted to a ledger. */
export function linkPayment(db: DB, p: DeclaredPayment, t: BankTxn, actor: { id: string; name: string }, how: "auto" | "on_record") {
  t.status = "matched";
  t.paymentId = p.id;
  t.untaggedReason = undefined;
  t.taggedAt = nowIso();
  t.taggedBy = actor.id;
  t.taggedByName = actor.name;
  t.reason = `Bank side of the payment ${p.byName} declared to ${p.publicPayee} (${fmt(p.amount)})`;
  p.status = "matched";
  p.bankTxnId = t.id;
  p.matchedAt = nowIso();
  p.matchedBy = actor.name;
  audit(db, {
    actor,
    action: "payment.matched",
    fundId: p.fundId,
    targetId: p.id,
    summary: `${how === "auto" ? "Bank line arrived for" : "Matched"} the declared payment of ${fmt(p.amount)} to ${p.publicPayee}: ${t.date} "${t.description.slice(0, 60)}". Not posted again.`,
    meta: { bankTxnId: t.id, amount: p.amount },
  });
}

/**
 * Statement import: is this new outgoing line the bank side of a payment
 * that's waiting for one? Call before tracking-code matching.
 */
export function matchOnImport(db: DB, ngoId: string, t: BankTxn) {
  if (t.amount >= 0 || t.isFee) return false;
  let best: { p: DeclaredPayment; score: number } | null = null;
  for (const p of paymentsOf(db)) {
    if (p.ngoId !== ngoId || p.status !== "awaiting_bank") continue;
    const f = fit(p, t);
    if (f && (!best || f.score > best.score)) best = { p, score: f.score };
  }
  if (!best) return false;
  linkPayment(db, best.p, t, SYSTEM_ACTOR, "auto");
  return true;
}

const memoOf = (p: DeclaredPayment) =>
  `${p.publicDescription} · ${PAYMENT_METHODS[p.method]}${p.invoiceNumber ? ` · invoice ${p.invoiceNumber}` : ""}${p.category ? ` · ${categoryLabel(p.category)}` : ""}`;

/** Money out of the fund, dated as on the receipt. */
export function postPayment(db: DB, p: DeclaredPayment): LedgerEntry {
  return appendLedger(db, { fundId: p.fundId, type: "expense", amount: -p.amount, memo: memoOf(p).slice(0, 300), actor: p.publicPayee, ref: p.id, ts: `${p.date}T12:00:00.000Z` });
}

/** Voiding posts the money back; the original entry stays on the chain. */
export function reversePayment(db: DB, p: DeclaredPayment, reason: string): LedgerEntry {
  return appendLedger(db, { fundId: p.fundId, type: "expense", amount: p.amount, memo: `Voided: ${memoOf(p)} · ${reason}`.slice(0, 300), actor: p.publicPayee, ref: p.id });
}

export function paymentView(db: DB, p: DeclaredPayment) {
  const t = p.bankTxnId ? db.bankTxns.find((x) => x.id === p.bankTxnId) : undefined;
  const file = p.receipt && db.files.find((f) => f.id === p.receipt!.fileId);
  return {
    id: p.id,
    fundId: p.fundId,
    fundTitle: db.funds.find((f) => f.id === p.fundId)?.title ?? p.fundId,
    category: p.category,
    amount: p.amount,
    payee: p.payee,
    publicPayee: p.publicPayee,
    date: p.date,
    method: p.method,
    methodLabel: PAYMENT_METHODS[p.method],
    invoiceNumber: p.invoiceNumber,
    description: p.description,
    status: p.status,
    receipt: p.receipt && { ...p.receipt, fileName: file?.name ?? "receipt", url: `/api/files/${p.receipt.fileId}` },
    bankLine: t ? { id: t.id, date: t.date, description: t.description, amount: t.amount } : undefined,
    matchedAt: p.matchedAt,
    matchedBy: p.matchedBy,
    byId: p.byId,
    byName: p.byName,
    createdAt: p.createdAt,
    voidedAt: p.voidedAt,
    voidedBy: p.voidedBy,
    voidReason: p.voidReason,
  };
}
