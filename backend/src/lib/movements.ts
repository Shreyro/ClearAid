import { bankParty } from "./flow";
import type { DB, LedgerEntry } from "./types";

export const TYPE_LABEL: Record<string, string> = {
  fund_opened: "Fund opened",
  donation: "Incoming funds",
  bank_in: "Bank receipt",
  bank_out: "Bank payment",
  withdrawal: "Vendor payout",
  withdrawal_rejected: "Request rejected",
  refund: "Refund",
  carry_forward_out: "Carried forward out",
  carry_forward_in: "Carried forward in",
  dispute_opened: "Dispute opened",
  fund_closing: "Closing started",
  fund_closed: "Fund closed",
};

/**
 * One ledger entry as a money movement: who it came from, who it went to,
 * and how it moved. Positive = into the fund, negative = out of it.
 */
export function movementView(db: DB, e: LedgerEntry, fundTitle: string) {
  let counterparty = e.actor;
  let counterpartyEmail: string | undefined;
  let via: string | undefined;
  let detailHref: string | undefined;
  if (e.type === "donation") {
    const d = db.donations.find((x) => x.id === e.ref);
    const donor = d && db.donors.find((x) => x.id === d.donorId);
    if (donor) {
      counterparty = donor.name;
      counterpartyEmail = donor.email.endsWith("@donor.local") ? undefined : donor.email;
    }
    via = e.paypalRef?.startsWith("MANUAL-") ? "Recorded by staff" : "PayPal";
  } else if (e.type === "carry_forward_in") {
    counterparty = `Fund: ${e.memo.match(/from "(.+)"/)?.[1] ?? "another fund"}`;
    via = "Carry forward";
  } else if (e.type === "carry_forward_out") {
    counterparty = `Fund: ${e.memo.match(/to "(.+)"/)?.[1] ?? "another fund"}`;
    via = "Carry forward";
  } else if (e.type === "withdrawal" || e.type === "withdrawal_rejected") {
    const w = db.withdrawals.find((x) => x.id === e.ref);
    const v = w && db.vendors.find((x) => x.id === w.vendorId);
    if (v) {
      counterparty = v.name;
      counterpartyEmail = v.paypalEmail;
    }
    via = "PayPal Payouts";
    if (w) detailHref = `/spend/${w.id}`;
  } else if (e.type === "bank_in" || e.type === "bank_out") {
    const t = db.bankTxns.find((x) => x.id === e.ref);
    const acc = t && db.bankAccounts.find((a) => a.id === t.accountId);
    if (t) {
      counterparty = bankParty(t);
      detailHref = `/untagged?status=all&q=${t.id}`;
    }
    via = acc ? `${acc.provider === "plaid" ? "Bank feed" : "Bank statement"} · ${acc.name}` : "Bank";
  } else if (e.type === "refund") {
    via = "PayPal refund";
  }

  const direction: "in" | "out" | "notice" = e.amount > 0 ? "in" : e.amount < 0 ? "out" : "notice";
  // A retag reverses an earlier bank entry: the money flows the opposite way to its type.
  const reversal = (e.type === "bank_in" && e.amount < 0) || (e.type === "bank_out" && e.amount > 0);
  const other = reversal ? `${counterparty} (retag reversal)` : counterparty;
  const from = direction === "in" ? other : direction === "out" ? fundTitle : "";
  const to = direction === "in" ? fundTitle : direction === "out" ? other : "";

  return {
    id: `${e.fundId}:${e.seq}`,
    seq: e.seq,
    fundId: e.fundId,
    fundTitle,
    ts: e.ts,
    type: e.type,
    typeLabel: reversal ? "Retag reversal" : (TYPE_LABEL[e.type] ?? e.type),
    direction,
    amount: e.amount,
    from,
    to,
    counterparty,
    counterpartyEmail,
    via,
    memo: e.memo,
    ref: e.ref,
    detailHref,
    paypalRef: e.paypalRef,
    hash: e.hash,
  };
}
