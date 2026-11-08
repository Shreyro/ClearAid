import { mutate } from "@/lib/db";
import { publish } from "@/lib/events";
import { recordDonation } from "@/lib/funds";
import { type Ctx, handle, json } from "@/lib/http";
import { fmt } from "@/lib/money";
import { captureDonationOrder } from "@/lib/paypal";
import { HttpError } from "@/lib/session";
import { givableFund } from "../../shared";

/**
 * Capture an approved donation and post it to the fund's ledger. If PayPal's
 * webhook got there first, the gift is already recorded and nothing is added.
 */
export const POST = handle(async (req: Request, ctx: Ctx<{ slug: string }>) => {
  const { slug } = await ctx.params;
  const { db, fund, code } = givableFund(slug);
  const { orderId } = (await req.json()) as { orderId?: string };
  const order = db.orders.find((o) => o.orderId === orderId && o.fundId === fund.id);
  if (!order) throw new HttpError(404, "Donation not found. Start again from the donation link.");
  if (order.status === "captured") return json({ ok: true, already: true, message: `Thank you. Your ${fmt(order.amount)} gift is recorded.` });

  const cap = await captureDonationOrder(order.orderId, order.amount);
  if (cap.status !== "COMPLETED") throw new HttpError(402, `PayPal reports the payment as ${cap.status.toLowerCase()}. Nothing was recorded.`);
  const entry = mutate((d) => {
    const o = d.orders.find((x) => x.orderId === order.orderId)!;
    if (o.status === "captured" || d.captures.some((c) => c.id === cap.captureId)) return null;
    o.status = "captured";
    return recordDonation(d, {
      fundId: fund.id,
      amount: cap.amount,
      captureId: cap.captureId,
      orderId: o.orderId,
      live: cap.live,
      donorEmail: o.donorEmail ?? cap.payerEmail,
      donorName: o.donorName ?? cap.payerName,
      showName: o.showName,
      memo: `${cap.live ? "Donation via PayPal" : "Donation via PayPal (simulated)"} · donation link${code ? ` · #${code}` : ""}`,
    }).entry;
  });
  if (entry) publish({ kind: "ledger", fundId: fund.id, entry });
  return json({ ok: true, captureId: cap.captureId, live: cap.live, message: `Thank you. Your ${fmt(cap.amount)} gift to ${fund.title} is on its ledger.` });
});
