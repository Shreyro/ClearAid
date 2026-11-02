import { getDb, mutate, nowIso } from "@/lib/db";
import { findFund } from "@/lib/funds";
import { handle, json } from "@/lib/http";
import { toCents } from "@/lib/money";
import { createDonationOrder } from "@/lib/paypal";
import { HttpError } from "@/lib/session";

/** Step 1 of the PayPal v6 one-time payment flow: create an Orders v2 order. */
export const POST = handle(async (req: Request) => {
  const b = (await req.json()) as { fundId: string; amountUsd: number; name?: string; email?: string; showName?: boolean };
  const fund = findFund(getDb(), b.fundId);
  if (!fund) throw new HttpError(404, "Fund not found");
  if (fund.status !== "active") throw new Error("This fund is no longer accepting donations");
  const amount = toCents(b.amountUsd);
  if (!(amount >= 100 && amount <= 1_000_000)) throw new Error("Donations must be between $1 and $10,000");
  const order = await createDonationOrder({ amount, fundId: fund.id, fundTitle: fund.title, reference: `${fund.id}:${Date.now()}` });
  mutate((db) =>
    db.orders.push({
      orderId: order.id,
      fundId: fund.id,
      amount,
      donorName: b.name?.trim().slice(0, 60) || undefined,
      donorEmail: b.email?.trim().toLowerCase().slice(0, 120) || undefined,
      showName: Boolean(b.showName),
      createdAt: nowIso(),
      status: "created",
    }),
  );
  return json({ id: order.id, simulated: !order.live });
});
