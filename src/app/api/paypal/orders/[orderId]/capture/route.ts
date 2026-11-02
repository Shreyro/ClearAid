import { NextResponse } from "next/server";
import { getDb, mutate, withLock } from "@/lib/db";
import { publish } from "@/lib/events";
import { recordDonation } from "@/lib/funds";
import { handle } from "@/lib/http";
import { captureDonationOrder } from "@/lib/paypal";
import { HttpError, SESSION_COOKIE } from "@/lib/session";

/** Step 2: capture after the donor approves in the PayPal popup, then write the donation to the ledger. */
export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/paypal/orders/[orderId]/capture">) => {
  const { orderId } = await ctx.params;
  return withLock(`order:${orderId}`, async () => {
    const pending = getDb().orders.find((o) => o.orderId === orderId);
    if (!pending) throw new HttpError(404, "Unknown order");
    if (pending.status === "captured") throw new Error("Order already captured");
    const cap = await captureDonationOrder(orderId, pending.amount);
    if (cap.status !== "COMPLETED" && cap.status !== "PENDING") throw new Error(`Payment ${cap.status.toLowerCase()}`);
    const { donor, donation, entry } = mutate((db) => {
      pending.status = "captured";
      return recordDonation(db, {
        fundId: pending.fundId,
        amount: cap.amount,
        captureId: cap.captureId,
        orderId,
        live: cap.live,
        donorEmail: pending.donorEmail || cap.payerEmail,
        donorName: pending.donorName || cap.payerName,
        showName: pending.showName,
      });
    });
    publish({ kind: "ledger", fundId: pending.fundId, entry });
    const res = NextResponse.json({ donationId: donation.id, captureId: cap.captureId, amount: cap.amount, donorId: donor.id, simulated: !cap.live, ledgerSeq: entry.seq, hash: entry.hash });
    // Sign the donor in (demo identity) so they can follow their dollar straight away.
    res.cookies.set(SESSION_COOKIE, `donor:${donor.id}`, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
    return res;
  });
});
