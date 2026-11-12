import {
  type AllocationInput,
  approvalNeeded,
  canApprove,
  canSeeTxn,
  canTagTo,
  controlsOf,
  missingReceipt,
  rejectTag,
  requestTag,
  tagManually,
  txnView,
} from "@/lib/banking";
import { audit } from "@/lib/audit";
import { getDb, mutate } from "@/lib/db";
import { findPayPalAccount } from "@/lib/paypal-accounts";
import { markTransfer } from "@/lib/transfers";
import { handle, json } from "@/lib/http";
import { fmt, toCents } from "@/lib/money";
import { actorOf, HttpError, requireNgo, type SignedInMember } from "@/lib/session";
import type { BankTxn, DB, LedgerEntry } from "@/lib/types";
import { announce } from "../shared";

const FILTERS: Record<string, (t: BankTxn, db: DB, ngoId: string) => boolean> = {
  untagged: (t) => t.status === "untagged",
  pending: (t) => Boolean(t.pending),
  receipts: (t, db, ngoId) => missingReceipt(db, t, ngoId),
  fees: (t) => t.status === "fee_unallocated",
  tagged: (t) => t.status === "tagged" || t.status === "auto_tagged" || t.status === "matched",
  transfers: (t) => t.status === "transfer",
  all: () => true,
};

/**
 * Bank lines from every connected account. ?status=untagged|pending|receipts|fees|tagged|all,
 * ?account=, ?fund=, ?q=. Staff see the untagged queue plus their own funds.
 */
export const GET = handle(async (req: Request) => {
  const me = await requireNgo();
  const db = getDb();
  const q = new URL(req.url).searchParams;
  const status = FILTERS[q.get("status") ?? ""] ? q.get("status")! : "untagged";
  const text = q.get("q")?.toLowerCase().trim();
  const accounts = new Set(db.bankAccounts.filter((a) => a.ngoId === me.ngoId).map((a) => a.id));
  const visible = db.bankTxns.filter((t) => accounts.has(t.accountId) && canSeeTxn(t, me, db));
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, visible.filter((t) => f(t, db, me.ngoId)).length]));
  const rows = visible
    .filter((t) => FILTERS[status](t, db, me.ngoId))
    .filter((t) => !q.get("account") || t.accountId === q.get("account"))
    .filter((t) => !q.get("fund") || t.allocations.some((a) => a.fundId === q.get("fund")) || t.pending?.allocations.some((a) => a.fundId === q.get("fund")))
    .filter((t) => !text || t.id === text || [t.description, t.counterparty, t.externalId, t.untaggedReason].some((v) => v?.toLowerCase().includes(text)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 2000)
    .map((t) => txnView(db, t, me));
  const funds = db.funds
    .filter((f) => f.ngoId === me.ngoId)
    .map((f) => ({ id: f.id, title: f.title, status: f.status, codes: f.trackingCodes ?? [], canTag: f.status !== "closed" && canTagTo(f, me) }));
  const c = controlsOf(db, me.ngoId);
  return json({
    transactions: rows,
    counts,
    funds,
    accounts: db.bankAccounts.filter((a) => accounts.has(a.id)).map((a) => ({ id: a.id, name: a.name })),
    controls: { tagApprovalThreshold: c.tagApprovalThreshold, receiptThreshold: c.receiptThreshold },
  });
});

type Body =
  | { action: "tag"; id: string; allocations: { fundId: string; amountUsd: number; category?: string }[]; reason: string }
  | { action: "bulk_tag"; ids: string[]; fundId: string; category?: string; reason: string }
  | { action: "approve"; id: string }
  | { action: "reject"; id: string; reason?: string }
  /** Admins: this deposit is a PayPal account's balance reaching the bank (already counted), or it isn't. */
  | { action: "mark_transfer"; id: string; paypalAccountId: string }
  | { action: "not_transfer"; id: string };

function checkMayTag(db: DB, t: BankTxn, me: SignedInMember, targets: string[]) {
  if (!canSeeTxn(t, me, db)) throw new HttpError(404, "Transaction not found");
  if (t.paymentId) throw new HttpError(409, "This line is the bank side of a declared payment, so it's already on that fund. Unlink it under Transactions → Declared payments first.");
  if (t.status === "transfer") throw new HttpError(409, "This line is money moved in from one of your PayPal accounts, which ClearAid already counted when the gifts came in. Putting it on a fund would count it twice. If it isn't a transfer, press \"Not a transfer\" first.");
  for (const fid of [...targets, ...t.allocations.map((a) => a.fundId)]) {
    const f = db.funds.find((x) => x.id === fid && x.ngoId === me.ngoId);
    if (!f) throw new HttpError(400, "Unknown fund");
    if (!canTagTo(f, me)) throw new HttpError(403, `You're not assigned to ${f.title}, so you can't move money onto or off it. Ask an admin.`);
  }
  if (t.pending) throw new HttpError(409, `${t.pending.byName}'s change on this line is waiting for approval. Approve or turn it down first.`);
}

/**
 * Tag, split, retag or untag by hand, and approve or turn down changes that
 * need a second person. Every change needs a reason and is audit-logged (one
 * entry per transaction). Nothing reaches a ledger until it's approved.
 */
export const POST = handle(async (req: Request) => {
  const me = await requireNgo();
  const b = (await req.json()) as Body;
  const actor = actorOf(me);
  const reason = String((b as { reason?: string }).reason ?? "").trim();
  if ((b.action === "tag" || b.action === "bulk_tag") && reason.length < 3) throw new HttpError(400, "Give a reason (it goes in the audit log)");

  const res = mutate((db) => {
    const find = (id: string) => {
      const t = db.bankTxns.find((x) => x.id === id);
      const acc = t && db.bankAccounts.find((a) => a.id === t.accountId && a.ngoId === me.ngoId);
      if (!t || !acc || !canSeeTxn(t, me, db)) throw new HttpError(404, "Transaction not found");
      return t;
    };
    const entries: LedgerEntry[] = [];
    let applied = 0;
    let requested = 0;
    const apply = (t: BankTxn, allocations: AllocationInput[]) => {
      const why = approvalNeeded(db, t, me.ngoId);
      if (why) {
        requestTag(db, t, allocations, reason, actor, why);
        requested += 1;
      } else {
        entries.push(...tagManually(db, t, allocations, reason, actor).entries);
        applied += 1;
      }
    };

    if (b.action === "tag") {
      const t = find(b.id);
      const allocations: AllocationInput[] = (b.allocations ?? []).map((a) => ({ fundId: a.fundId, amount: toCents(a.amountUsd), category: a.category || undefined }));
      checkMayTag(db, t, me, allocations.map((a) => a.fundId));
      apply(t, allocations);
    } else if (b.action === "bulk_tag") {
      const ids = [...new Set(b.ids ?? [])].slice(0, 200);
      if (!ids.length) throw new HttpError(400, "Select at least one transaction");
      const ts = ids.map(find);
      for (const t of ts) checkMayTag(db, t, me, [b.fundId]);
      for (const t of ts) apply(t, [{ fundId: b.fundId, amount: Math.abs(t.amount), category: b.category || undefined }]);
    } else if (b.action === "approve") {
      const t = find(b.id);
      const p = t.pending;
      if (!p) throw new HttpError(400, "Nothing is waiting for approval on this line");
      if (p.byId === me.id) throw new HttpError(403, "You made this change, so someone else has to approve it");
      if (!canApprove(db, t, me)) throw new HttpError(403, "Only an admin or someone assigned to every fund involved can approve this");
      const maker = { id: p.byId, name: p.byName };
      entries.push(...tagManually(db, t, p.allocations.map((a) => ({ fundId: a.fundId, amount: a.amount, category: a.category })), p.reason, maker, { by: actor }).entries);
      applied += 1;
    } else if (b.action === "mark_transfer" || b.action === "not_transfer") {
      if (me.role !== "admin") throw new HttpError(403, "Only an admin can mark transfers between your own accounts");
      const t = find(b.id);
      const account = db.bankAccounts.find((a) => a.id === t.accountId)!;
      if (b.action === "mark_transfer") {
        if (t.amount <= 0) throw new HttpError(400, "Only money coming in can be a transfer from PayPal");
        if (t.status !== "untagged" && t.status !== "fee_unallocated") throw new HttpError(409, t.status === "transfer" ? "It's already marked as a transfer" : "This line is already on a fund. Untag it first, so nothing is counted twice.");
        if (t.pending || t.paymentId) throw new HttpError(409, "This line has a change waiting or is a declared payment's bank side");
        const pp = findPayPalAccount(db, me.ngoId, b.paypalAccountId);
        if (!pp) throw new HttpError(400, "Choose one of your PayPal accounts");
        markTransfer(db, t, pp.id, "manual", me.name);
        audit(db, { actor, action: "bank.transfer_marked", targetId: t.id, summary: `Marked ${fmt(t.amount)} on ${account.name} (${t.date}) as a transfer from PayPal account "${pp.name}": money already counted, not put on a fund` });
      } else {
        if (t.status !== "transfer") throw new HttpError(400, "This line isn't marked as a transfer");
        const was = t.transfer;
        t.transfer = undefined;
        t.notTransfer = true;
        t.status = "untagged";
        t.untaggedReason = "Not a transfer: tag it to a fund";
        audit(db, { actor, action: "bank.transfer_unmarked", targetId: t.id, summary: `Said ${fmt(t.amount)} on ${account.name} (${t.date}) isn't a transfer${was ? ` from PayPal account ${findPayPalAccount(db, me.ngoId, was.paypalAccountId)?.name ?? was.paypalAccountId}` : ""}; it now waits in Untagged` });
      }
      applied += 1;
    } else if (b.action === "reject") {
      const t = find(b.id);
      const p = t.pending;
      if (!p) throw new HttpError(400, "Nothing is waiting for approval on this line");
      if (p.byId !== me.id && !canApprove(db, t, me)) throw new HttpError(403, "Only the person who asked, an admin, or someone assigned to the funds involved can turn this down");
      rejectTag(db, t, actor, reason);
    } else throw new HttpError(400, "Unknown action");
    return { entries, applied, requested };
  });
  announce(res.entries);
  const moved = res.entries.reduce((s, e) => s + e.amount, 0);
  const parts: string[] = [];
  if (b.action === "mark_transfer") parts.push("Marked as a transfer from PayPal: it stays off every fund, so nothing is counted twice");
  else if (b.action === "not_transfer") parts.push("Not a transfer: it's in Untagged, ready to be tagged to a fund");
  else if (b.action === "approve") parts.push("Approved");
  else if (b.action === "reject") parts.push("Change turned down; the line is unchanged");
  else {
    if (res.applied) parts.push(`${res.applied === 1 ? "Transaction" : `${res.applied} transactions`} updated`);
    if (res.requested) parts.push(`${res.requested === 1 ? "1 change" : `${res.requested} changes`} sent for approval (a second person must sign off)`);
  }
  if (res.entries.length) parts.push(`${res.entries.length} ledger entr${res.entries.length === 1 ? "y" : "ies"} posted (net ${fmt(moved)})`);
  return json({ ok: true, ...res, entries: undefined, message: parts.join(" · ") });
});
