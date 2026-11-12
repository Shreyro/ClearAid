import { getDb, mutate } from "@/lib/db";
import { publish } from "@/lib/events";
import { donorLabel, recordDonation } from "@/lib/funds";
import { handle, json } from "@/lib/http";
import { appendLedger } from "@/lib/ledger";
import { fmt, toCents } from "@/lib/money";
import { verifyWebhook } from "@/lib/paypal";
import { connOf, defaultAccount, DEFAULT_PAYPAL } from "@/lib/paypal-accounts";
import { partnerConn } from "@/lib/paypal-partner";
import type { DB, PayPalAccount } from "@/lib/types";
import { applyReturnPayoutEvent } from "@/lib/returns";
import { payoutCameBack } from "@/lib/paypal-pay";

type Event = { id: string; event_type: string; resource: Record<string, unknown> & { id?: string } };

/**
 * PayPal webhooks keep the public ledger true even when something happens
 * outside ClearAid: a refund issued from the PayPal dashboard, a dispute, a
 * payout that bounced, or a capture the browser never reported back.
 *
 * Each PayPal account sends its webhooks here with ?account=<id> (the main
 * account: no parameter), and the signature is checked with that account.
 * Accounts connected by logging in share ClearAid's partner app webhook
 * (?account=partner): its signature is checked with the partner app, and each
 * event is matched to the connected account it concerns.
 */

/** For a partner-app event: the connected account whose order or capture it is about. */
function partnerAccountFor(db: DB, r: Record<string, unknown>): PayPalAccount | undefined {
  const orderId = (r.supplementary_data as { related_ids?: { order_id?: string } } | undefined)?.related_ids?.order_id;
  const up = (r.links as { rel: string; href: string }[] | undefined)?.find((l) => l.rel === "up")?.href?.split("/").pop();
  const disputed = (r.disputed_transactions as { seller_transaction_id?: string }[] | undefined)?.[0]?.seller_transaction_id;
  const accountId =
    db.orders.find((o) => o.orderId === orderId)?.accountId ??
    db.captures.find((c) => c.id === (up ?? disputed ?? r.id))?.accountId;
  return (db.paypalAccounts ?? []).find((a) => a.id === accountId && a.mode === "partner" && a.status === "active");
}
export const POST = handle(async (req: Request) => {
  const raw = await req.text();
  const event = JSON.parse(raw) as Event;
  const accountId = new URL(req.url).searchParams.get("account") || DEFAULT_PAYPAL;
  const db0 = getDb();
  let account: PayPalAccount | undefined;
  if (accountId === "partner") {
    if (!(await verifyWebhook(partnerConn(), req.headers, event))) return json({ error: "Signature verification failed or not configured" }, 401);
    account = partnerAccountFor(db0, event.resource ?? {});
    if (!account) return json({ ok: true, ignored: "not about a connected account" });
  } else {
    account = accountId === DEFAULT_PAYPAL ? defaultAccount(db0.ngos[0]?.id ?? "") : (db0.paypalAccounts ?? []).find((a) => a.id === accountId && a.status === "active");
    if (!account) return json({ error: "Unknown PayPal account" }, 404);
    if (!(await verifyWebhook(connOf(account), req.headers, event))) return json({ error: "Signature verification failed or not configured" }, 401);
  }
  if (getDb().processedWebhooks.includes(event.id)) return json({ ok: true, duplicate: true });

  const r = event.resource;
  const entries = mutate((db) => {
    db.processedWebhooks.push(event.id);
    const out = [];
    switch (event.event_type) {
      case "PAYMENT.CAPTURE.COMPLETED": {
        if (db.captures.some((c) => c.id === r.id)) break;
        const orderId = (r.supplementary_data as { related_ids?: { order_id?: string } })?.related_ids?.order_id;
        const pending = db.orders.find((o) => o.orderId === orderId && o.status === "created" && (o.accountId ?? DEFAULT_PAYPAL) === account.id);
        if (!pending) break;
        pending.status = "captured";
        out.push(
          recordDonation(db, {
            fundId: pending.fundId,
            amount: toCents((r.amount as { value: string }).value),
            captureId: String(r.id),
            accountId: account.id,
            orderId: pending.orderId,
            live: true,
            donorEmail: pending.donorEmail,
            donorName: pending.donorName,
            showName: pending.showName,
            returnOptIn: pending.returnOptIn,
          }).entry,
        );
        break;
      }
      case "PAYMENT.CAPTURE.REFUNDED": {
        // resource is the refund; its "up" link points at the capture
        const up = (r.links as { rel: string; href: string }[] | undefined)?.find((l) => l.rel === "up")?.href;
        const capId = up?.split("/").pop();
        const cap = db.captures.find((c) => c.id === capId && (c.accountId ?? DEFAULT_PAYPAL) === account.id);
        if (!cap || db.ledger.some((l) => l.paypalRef?.split(",").includes(String(r.id)))) break;
        const amt = toCents((r.amount as { value: string }).value);
        const donation = db.donations.find((d) => d.captureIds.includes(cap.id) && d.source === "paypal");
        if (!donation) break;
        cap.refunded += amt;
        donation.refunded += amt;
        out.push(
          appendLedger(db, {
            fundId: donation.fundId,
            type: "refund",
            amount: -amt,
            memo: "Refund issued directly in PayPal (detected via webhook)",
            actor: donorLabel(db.donors.find((d) => d.id === donation.donorId)),
            paypalRef: String(r.id),
          }),
        );
        break;
      }
      case "PAYMENT.PAYOUTS-ITEM.SUCCEEDED":
      case "PAYMENT.PAYOUTS-ITEM.FAILED":
      case "PAYMENT.PAYOUTS-ITEM.UNCLAIMED":
      case "PAYMENT.PAYOUTS-ITEM.RETURNED":
      case "PAYMENT.PAYOUTS-ITEM.BLOCKED":
      case "PAYMENT.PAYOUTS-ITEM.REFUNDED":
      case "PAYMENT.PAYOUTS-ITEM.REVERSED": {
        const itemId = (r.payout_item as { sender_item_id?: string } | undefined)?.sender_item_id;
        const itemStatus = String(r.transaction_status ?? event.event_type.split(".").pop());
        const w = db.withdrawals.find((x) => x.id === itemId);
        if (w?.payout) w.payout.status = itemStatus;
        // A leftover returned to a donor by payout: completed, unclaimed, or back on the fund.
        const back = itemId ? applyReturnPayoutEvent(db, itemId, itemStatus) : null;
        if (back) out.push(back);
        // A PayPal payment sent from the Transactions page: failed or came back means it's voided and posted back.
        const undone = itemId ? payoutCameBack(db, itemId, itemStatus) : null;
        if (undone) out.push(undone);
        break;
      }
      case "CUSTOMER.DISPUTE.CREATED": {
        const capId = (r.disputed_transactions as { seller_transaction_id?: string }[] | undefined)?.[0]?.seller_transaction_id;
        const cap = db.captures.find((c) => c.id === capId);
        const donation = cap && db.donations.find((d) => d.captureIds.includes(cap.id) && d.source === "paypal");
        if (!donation || !cap) break;
        out.push(
          appendLedger(db, {
            fundId: donation.fundId,
            type: "dispute_opened",
            amount: 0,
            memo: `A donor opened a PayPal dispute on a ${fmt(cap.amount)} donation. The NGO must respond in PayPal.`,
            actor: "PayPal",
            paypalRef: String(r.dispute_id ?? r.id),
          }),
        );
        break;
      }
    }
    return out;
  });
  entries.forEach((entry) => publish({ kind: "ledger", fundId: entry.fundId, entry }));
  return json({ ok: true, recorded: entries.length });
});
