import { audit, SYSTEM_ACTOR } from "./audit";
import { statementAnonymiser } from "./banking";
import { getDb, mutate, newId, nowIso, withLock } from "./db";
import { publish } from "./events";
import { findFund, fundStats } from "./funds";
import { fmt } from "./money";
import { paymentsOf, postPayment, reversePayment } from "./payments";
import { sendPayout } from "./paypal";
import { connOf, fundAccount } from "./paypal-accounts";
import { owedToDonors } from "./returns";
import { HttpError, type SignedInMember } from "./session";
import { CATEGORIES, type Category, type DB, type DeclaredPayment, type LedgerEntry } from "./types";

/**
 * Paying someone through PayPal from a fund: a PayPal payout from the fund's
 * own PayPal account to the payee's PayPal email, recorded as a payment on
 * the fund's ledger.
 *
 * Who may: admins, and staff an admin allowed (Settings → Team), only from the
 * funds they're assigned to. The amount must be covered by what the fund still
 * holds (less anything owed to donors who asked for their share back).
 * If PayPal later reports the payout failed or came back, the payment is
 * voided and the money posted back to the fund (see payoutCameBack).
 */

export type PayPalPaymentInput = {
  fundId: string;
  amount: number;
  /** Who is paid, and their PayPal email. */
  payee: string;
  email: string;
  description: string;
  category?: string;
  /** A receipt or invoice uploaded first (optional). */
  fileId?: string;
};

export const mayPay = (db: DB, me: SignedInMember, fundId: string) =>
  me.canPay && (me.role === "admin" || Boolean(db.funds.find((f) => f.id === fundId)?.assignees.includes(me.id)));

export async function sendPayPalPayment(me: SignedInMember, input: PayPalPaymentInput) {
  if (!me.canPay) throw new HttpError(403, "You aren't allowed to send PayPal payments. An admin can allow it under Settings → Team.");
  const db0 = getDb();
  const fund = findFund(db0, input.fundId);
  if (!fund || fund.ngoId !== me.ngoId) throw new HttpError(404, "Fund not found");
  if (!mayPay(db0, me, fund.id)) throw new HttpError(403, `You can only pay from funds you're assigned to, and you're not on ${fund.title}`);
  if (fund.status === "closed") throw new HttpError(400, `${fund.title} is closed`);
  if (!(input.amount > 0) || input.amount > 10_000_00) throw new HttpError(400, "Enter an amount between $0.01 and $10,000 (PayPal's single-payout limit for this kind of payment)");
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter the payee's PayPal email");
  const payee = input.payee.trim().slice(0, 120);
  if (!payee) throw new HttpError(400, "Who is being paid?");
  const description = input.description.trim().slice(0, 200);
  if (description.length < 3) throw new HttpError(400, "Say what it's for (it goes on the fund's ledger)");
  const category = input.category ? (CATEGORIES.find((c) => c.id === input.category)?.id as Category | undefined) : undefined;
  if (input.category && !category) throw new HttpError(400, "Unknown category");

  const account = fundAccount(db0, fund);
  const conn = connOf(account);
  if (account.mode === "partner") throw new HttpError(400, `${fund.title} pays into "${account.name}", which is connected by login: PayPal doesn't let ClearAid send payouts from it. Pay from that PayPal account and record the payment.`);
  if (account.mode === "live" && !conn.live) throw new HttpError(400, `"${account.name}" isn't working (its PayPal keys failed), so nothing can be sent from it`);

  return withLock(`fund:${fund.id}`, async () => {
    const db = getDb();
    const f = findFund(db, fund.id)!;
    const free = fundStats(db, f).balance - owedToDonors(db, f);
    if (input.amount > free) throw new HttpError(400, `${f.title} holds ${fmt(Math.max(0, free))} that can be paid out${owedToDonors(db, f) ? " (after what's owed to donors)" : ""}, less than ${fmt(input.amount)}`);
    const file = input.fileId ? db.files.find((x) => x.id === input.fileId && x.kind === "receipt" && !x.public && x.scan?.ngoId === me.ngoId) : undefined;
    if (input.fileId && !file) throw new HttpError(400, "Upload the receipt or invoice again");
    if (file && paymentsOf(db).some((p) => p.receipt?.fileId === file.id && p.status !== "void")) throw new HttpError(409, "This receipt was already used for another payment");

    const id = newId("pay");
    let payout;
    try {
      payout = await sendPayout(conn, {
        itemId: id,
        email,
        amount: input.amount,
        note: `${f.title}: ${description}`.slice(0, 400),
        subject: `Payment from ${db.ngos.find((n) => n.id === f.ngoId)?.name ?? "ClearAid"}`.slice(0, 255),
        message: description,
      });
    } catch (e) {
      throw new HttpError(502, `PayPal didn't send the payment from "${account.name}": ${(e as Error).message}`);
    }

    const out = mutate((d) => {
      const shown = statementAnonymiser(d, me.ngoId)({ date: nowIso().slice(0, 10), amount: -input.amount, description, counterparty: payee });
      const p: DeclaredPayment = {
        id,
        ngoId: me.ngoId,
        fundId: f.id,
        category,
        amount: input.amount,
        payee,
        date: nowIso().slice(0, 10),
        method: "paypal",
        description,
        publicPayee: shown.counterparty || payee,
        publicDescription: shown.description,
        ...(file ? { receipt: { fileId: file.id, engine: file.scan?.engine ?? "none", extraction: file.scan?.extraction, note: file.scan?.note } } : {}),
        status: "no_bank",
        payout: { accountId: account.id, email, batchId: payout.batchId, status: payout.status, live: payout.live },
        byId: me.id,
        byName: me.name,
        createdAt: nowIso(),
      };
      paymentsOf(d).push(p);
      const entry = postPayment(d, p);
      audit(d, {
        actor: { id: me.id, name: me.name },
        action: "payment.paypal_sent",
        fundId: f.id,
        targetId: p.id,
        summary: `Sent ${fmt(input.amount)} by PayPal to ${p.publicPayee} from ${f.title} ("${account.name}"${payout.live ? "" : ", simulated"}): ${p.publicDescription}`,
        meta: { amount: input.amount, batchId: payout.batchId, live: payout.live },
      });
      return { p, entry };
    });
    publish({ kind: "ledger", fundId: f.id, entry: out.entry });
    return { payment: out.p, account: account.name, live: payout.live };
  });
}

/**
 * A payout webhook about a PayPal payment. Completed: noted. Failed, returned,
 * blocked or reversed: the payment is voided and the money goes back on the fund.
 */
export function payoutCameBack(db: DB, itemId: string, status: string): LedgerEntry | null {
  const p = paymentsOf(db).find((x) => x.id === itemId && x.method === "paypal");
  if (!p?.payout) return null;
  const s = status.toUpperCase();
  p.payout.status = s;
  if (!["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED"].includes(s) || p.status === "void") return null;
  p.status = "void";
  p.voidedAt = nowIso();
  p.voidedBy = "PayPal";
  p.voidReason = `PayPal payout ${s.toLowerCase()}`;
  audit(db, { actor: SYSTEM_ACTOR, action: "payment.voided", fundId: p.fundId, targetId: p.id, summary: `The ${fmt(p.amount)} PayPal payment to ${p.publicPayee} came back (${s.toLowerCase()}); the money was posted back to the fund` });
  return reversePayment(db, p, `PayPal payout ${s.toLowerCase()}`);
}
