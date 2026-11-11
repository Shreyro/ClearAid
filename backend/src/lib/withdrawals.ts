import { audit } from "./audit";
import { getDb, mutate, nowIso } from "./db";
import { publish } from "./events";
import { findFund, payWithdrawal, requiredApprovals } from "./funds";
import { appendLedger } from "./ledger";
import { fmt } from "./money";
import { activeAssignees, HttpError, isAssigned } from "./session";
import type { Fund, Withdrawal } from "./types";

/** An approver signs or rejects a payment request; enough signatures pay it out. */
function signedMessage(fund: Fund, w: Withdrawal) {
  const remaining = requiredApprovals(fund, w) - w.approvals.filter((a) => a.decision === "approve").length;
  const others = activeAssignees(getDb(), fund).filter((m) => !w.approvals.some((a) => a.by === m.id));
  if (others.length < remaining) return `Signed. ${remaining} more approval(s) needed, but nobody else is assigned to ${fund.title} yet. An admin needs to assign a second approver.`;
  return `Signed. ${remaining} more approval(s) needed from: ${others.map((m) => m.name).join(", ")}`;
}

export async function decideWithdrawal(withdrawalId: string, admin: { id: string; name: string }, decision: "approve" | "reject", note?: string) {
  const res = mutate((db) => {
    const w = db.withdrawals.find((x) => x.id === withdrawalId);
    if (!w) throw new Error("Unknown withdrawal");
    if (w.status !== "pending_approval" && w.status !== "payout_failed") throw new Error(`Request is ${w.status}`);
    const fund = findFund(db, w.fundId)!;
    if (!isAssigned(fund, admin.id)) throw new HttpError(403, `You're not assigned to ${fund.title}. Only people assigned to a fund can sign its withdrawals.`);
    if (w.approvals.some((a) => a.by === admin.id)) throw new Error("You have already signed this request; a different assigned approver must co-sign");
    w.approvals.push({ by: admin.id, name: admin.name, decision, note, at: nowIso() });
    const sigs = w.approvals.filter((a) => a.decision === "approve").length;
    audit(db, {
      actor: admin,
      action: decision === "reject" ? "withdrawal.rejected" : "withdrawal.signed",
      fundId: fund.id,
      targetId: w.id,
      summary: decision === "reject" ? `Rejected a ${fmt(w.amount)} payment request${note ? `: ${note}` : ""}` : `Signed a ${fmt(w.amount)} payment request (${sigs} of ${requiredApprovals(fund, w)} signatures)`,
      meta: { amount: w.amount, signatures: sigs, required: requiredApprovals(fund, w) },
    });
    if (decision === "reject") {
      w.status = "rejected";
      const vendor = db.vendors.find((v) => v.id === w.vendorId);
      const entry = appendLedger(db, {
        fundId: fund.id,
        type: "withdrawal_rejected",
        amount: 0,
        memo: `Request for ${fmt(w.amount)} rejected after review${note ? `: ${note}` : ""}`,
        actor: vendor?.name ?? "Vendor",
        ref: w.id,
      });
      return { w, fund, entry, pay: false };
    }
    const approvals = w.approvals.filter((a) => a.decision === "approve").length;
    return { w, fund, entry: null, pay: approvals >= requiredApprovals(fund, w) };
  });
  if (res.entry) publish({ kind: "ledger", fundId: res.fund.id, entry: res.entry });
  publish({ kind: "withdrawal", fundId: res.fund.id, withdrawalId, status: res.w.status });
  if (res.pay) await payWithdrawal(withdrawalId, admin.name);
  const w = getDb().withdrawals.find((x) => x.id === withdrawalId)!;
  return {
    status: w.status,
    approvals: w.approvals.length,
    required: requiredApprovals(res.fund, w),
    payout: w.payout,
    message:
      w.status === "paid"
        ? `Paid ${fmt(w.amount)} via PayPal Payouts (batch ${w.payout?.batchId})`
        : w.status === "rejected"
          ? "Rejected and logged on the public ledger"
          : signedMessage(res.fund, w),
  };
}
