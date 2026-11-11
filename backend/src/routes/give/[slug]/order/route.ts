import { mutate, nowIso } from "@/lib/db";
import { type Ctx, handle, json } from "@/lib/http";
import { fmt, toCents } from "@/lib/money";
import { createDonationOrder } from "@/lib/paypal";
import { fundConn } from "@/lib/paypal-accounts";
import { HttpError } from "@/lib/session";
import { givableFund, MAX_GIFT, MIN_GIFT } from "../../shared";

/**
 * Start a PayPal donation from a fund's public link. The fund's tracking code
 * goes in the order's custom_id and description, so the money can be traced to
 * the fund in PayPal's own records as well as on ClearAid's ledger.
 */
export const POST = handle(async (req: Request, ctx: Ctx<{ slug: string }>) => {
  const { slug } = await ctx.params;
  const { db, fund, code } = givableFund(slug);
  if (fund.status !== "active") throw new HttpError(400, `${fund.title} isn't taking donations`);
  const b = (await req.json()) as { amountUsd?: number; name?: string; email?: string; showName?: boolean };
  const amount = toCents(b.amountUsd ?? 0);
  if (!(amount >= MIN_GIFT) || amount > MAX_GIFT) throw new HttpError(400, `Give between ${fmt(MIN_GIFT)} and ${fmt(MAX_GIFT)}`);
  const email = b.email?.trim().slice(0, 120);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "That email doesn't look right");
  const reference = code ? `#${code}` : fund.id;
  const pp = fundConn(db, fund);
  const order = await createDonationOrder(pp, { amount, fundId: fund.id, fundTitle: `${fund.title}${code ? ` #${code}` : ""}`, reference });
  mutate((db) =>
    db.orders.push({
      orderId: order.id,
      fundId: fund.id,
      accountId: pp.id,
      amount,
      donorName: b.name?.trim().slice(0, 80) || undefined,
      donorEmail: email || undefined,
      showName: Boolean(b.showName),
      createdAt: nowIso(),
      status: "created",
    }),
  );
  return json({ id: order.id, live: order.live });
});
