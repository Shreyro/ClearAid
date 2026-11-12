import { mutate, nowIso } from "@/lib/db";
import { publish } from "@/lib/events";
import { recordDonation } from "@/lib/funds";
import { type Ctx, handle, json } from "@/lib/http";
import { fmt, toCents } from "@/lib/money";
import { sandboxCardDonation } from "@/lib/paypal";
import { fundAccount, connOf } from "@/lib/paypal-accounts";
import { HttpError, requireNgoAdmin } from "@/lib/session";
import { givableFund, MAX_GIFT, MIN_GIFT } from "../../shared";

/**
 * Sandbox only (admins): give to a fund with PayPal's test card, through the
 * fund's own PayPal account, and record it like any donation. Each gift is a
 * real capture in the PayPal sandbox, so test data matches what PayPal shows.
 * Refused unless the fund's account is a live PayPal *sandbox* account.
 */
export const POST = handle(async (req: Request, ctx: Ctx<{ slug: string }>) => {
  const admin = await requireNgoAdmin();
  const { slug } = await ctx.params;
  const { db, fund, code } = givableFund(slug);
  if (fund.ngoId !== admin.ngoId) throw new HttpError(404, "Fund not found");
  if (fund.status !== "active") throw new HttpError(400, `${fund.title} isn't taking donations`);
  const b = (await req.json()) as { amountUsd?: number; name?: string; email?: string; showName?: boolean; returnOptIn?: boolean };
  const amount = toCents(b.amountUsd ?? 0);
  if (!(amount >= MIN_GIFT) || amount > MAX_GIFT) throw new HttpError(400, `Give between ${fmt(MIN_GIFT)} and ${fmt(MAX_GIFT)}`);
  const account = fundAccount(db, fund);
  const conn = connOf(account);
  if (!conn.live || conn.env !== "sandbox") throw new HttpError(400, `${fund.title} pays into "${account.name}", which isn't a live PayPal sandbox account. Test-card gifts only run in the sandbox.`);
  const reference = code ? `#${code}` : fund.id;
  let cap;
  try {
    cap = await sandboxCardDonation(conn, { amount, fundId: fund.id, fundTitle: `${fund.title}${code ? ` #${code}` : ""}`, reference, payerName: b.name });
  } catch (e) {
    throw new HttpError(402, `PayPal refused the test payment on "${account.name}": ${(e as Error).message}. The account must accept card payments (US sandbox business accounts do).`);
  }
  const entry = mutate((d) => {
    d.orders.push({ orderId: cap.orderId, fundId: fund.id, accountId: account.id, amount: cap.amount, donorName: b.name?.trim().slice(0, 80) || undefined, donorEmail: b.email?.trim().slice(0, 120) || undefined, showName: Boolean(b.showName), ...(b.returnOptIn && fund.donorReturns ? { returnOptIn: true } : {}), createdAt: nowIso(), status: "captured" });
    return recordDonation(d, {
      fundId: fund.id,
      amount: cap.amount,
      captureId: cap.captureId,
      accountId: account.id,
      orderId: cap.orderId,
      live: true,
      donorEmail: b.email?.trim() || undefined,
      donorName: b.name?.trim() || undefined,
      showName: Boolean(b.showName),
      returnOptIn: Boolean(b.returnOptIn && fund.donorReturns),
      payerEmail: b.email?.trim() || undefined,
      memo: `Donation via PayPal (sandbox test card) · ${account.name}${code ? ` · #${code}` : ""}`,
    }).entry;
  });
  publish({ kind: "ledger", fundId: fund.id, entry });
  return json({ ok: true, captureId: cap.captureId, orderId: cap.orderId, amount: cap.amount, account: account.name, message: `${fmt(cap.amount)} paid to ${account.name} in the PayPal sandbox and recorded on ${fund.title}.` });
});
