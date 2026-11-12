import { nowIso } from "./db";
import { fmt } from "./money";
import { DEFAULT_PAYPAL, findPayPalAccount } from "./paypal-accounts";
import { returnsOf } from "./returns";
import type { BankAccount, BankTxn, DB } from "./types";

/**
 * Money moving between the NGO's own accounts: a PayPal account withdrawing its
 * balance to the bank. ClearAid already counted that money when the PayPal gift
 * came in, so the bank deposit is a transfer, not new money: it never goes on a
 * fund (which would count it twice) and doesn't wait in Untagged.
 *
 * An admin links a bank account to the PayPal accounts that withdraw into it.
 * Deposits on that bank that read like a PayPal transfer are then marked as
 * transfers when they're imported. Admins can also mark or unmark a line by
 * hand; a line someone said isn't a transfer is left alone after that.
 */

/** How banks describe a PayPal withdrawal: "PAYPAL TRANSFER", "PAYPAL INST XFER", "PAYPAL *WITHDRAW", "PAYPAL PPD". */
export function looksLikePayPalTransfer(t: Pick<BankTxn, "amount" | "description">) {
  return t.amount > 0 && /\bpay\s?pal\b/i.test(t.description) && /\b(transfer|xfer|withdraw\w*|ppd|inst|payout|ach)\b/i.test(t.description);
}

/** Collected on a PayPal account, what left it from ClearAid, what reached the bank, and the rest. Cents. */
export function paypalReconciliation(db: DB, ngoId: string, paypalAccountId: string) {
  const ngoFunds = new Set(db.funds.filter((f) => f.ngoId === ngoId).map((f) => f.id));
  const ngoCaptures = new Set(db.donations.filter((d) => d.source === "paypal" && ngoFunds.has(d.fundId)).flatMap((d) => d.captureIds));
  const captures = db.captures.filter((c) => (c.accountId ?? DEFAULT_PAYPAL) === paypalAccountId && ngoCaptures.has(c.id));
  const collected = captures.reduce((s, c) => s + c.amount, 0);
  const refunded = captures.reduce((s, c) => s + c.refunded, 0);
  const paidOut =
    returnsOf(db)
      .filter((r) => r.ngoId === ngoId && r.method === "payout" && (r.accountId ?? DEFAULT_PAYPAL) === paypalAccountId && r.status !== "failed" && r.status !== "returned")
      .reduce((s, r) => s + r.amount, 0) +
    // PayPal payments sent from the Transactions page.
    (db.payments ?? []).filter((p) => p.ngoId === ngoId && p.method === "paypal" && p.status !== "void" && p.payout?.accountId === paypalAccountId).reduce((s, p) => s + p.amount, 0);
  const ngoBanks = new Set(db.bankAccounts.filter((a) => a.ngoId === ngoId).map((a) => a.id));
  const transfers = db.bankTxns.filter((t) => t.status === "transfer" && t.transfer?.paypalAccountId === paypalAccountId && ngoBanks.has(t.accountId));
  const toBank = transfers.reduce((s, t) => s + t.amount, 0);
  const available = collected - refunded - paidOut;
  return {
    collected,
    refunded,
    paidOut,
    toBank,
    transfers: transfers.length,
    lastTransfer: transfers.map((t) => t.date).sort().pop() ?? null,
    /** Still in PayPal by ClearAid's records, before PayPal's own fees (which aren't recorded). */
    stillInPayPal: available - toBank,
    banks: db.bankAccounts.filter((a) => a.ngoId === ngoId && a.status === "active" && (a.transfersFrom ?? []).includes(paypalAccountId)).map((a) => ({ id: a.id, name: a.name })),
    warning:
      toBank > available
        ? `${fmt(toBank - available)} more reached the bank than ClearAid recorded this account collecting (after refunds and payouts). Check the bank link, or gifts made outside ClearAid.`
        : undefined,
  };
}

/** Which linked PayPal account a deposit came from: the only one, or the one with enough still in it. */
export function transferSource(db: DB, account: BankAccount, t: BankTxn): string | undefined {
  const linked = (account.transfersFrom ?? []).filter((id) => findPayPalAccount(db, account.ngoId, id));
  if (!linked.length || t.notTransfer || !looksLikePayPalTransfer(t)) return undefined;
  if (linked.length === 1) return linked[0];
  return linked.find((id) => paypalReconciliation(db, account.ngoId, id).stillInPayPal >= t.amount) ?? linked[0];
}

/** Mark a line as a transfer from a PayPal account. Only lines not already on a fund. */
export function markTransfer(db: DB, t: BankTxn, paypalAccountId: string, how: "rule" | "manual", byName?: string) {
  t.status = "transfer";
  t.transfer = { paypalAccountId, how, ...(byName ? { byName } : {}), at: nowIso() };
  t.untaggedReason = undefined;
  t.notTransfer = undefined;
}

/** Look again at a bank account's untagged deposits after its PayPal link changes. */
export function rescanTransfers(db: DB, account: BankAccount) {
  let marked = 0;
  for (const t of db.bankTxns) {
    if (t.accountId !== account.id || t.status !== "untagged" || t.pending || t.paymentId) continue;
    const src = transferSource(db, account, t);
    if (src) {
      markTransfer(db, t, src, "rule");
      marked++;
    }
  }
  return marked;
}

/** The PayPal account a transfer line came from, for display. */
export function transferLabel(db: DB, t: BankTxn) {
  if (!t.transfer) return null;
  const ngoId = db.bankAccounts.find((a) => a.id === t.accountId)?.ngoId ?? "";
  const pp = findPayPalAccount(db, ngoId, t.transfer.paypalAccountId);
  return { paypalAccountId: t.transfer.paypalAccountId, paypalAccountName: pp?.name ?? "PayPal", how: t.transfer.how, byName: t.transfer.byName, at: t.transfer.at };
}
