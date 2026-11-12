import { fundConn } from "@/lib/paypal-accounts";
import { type Ctx, handle, json } from "@/lib/http";
import { givableFund, MAX_GIFT, MIN_GIFT } from "../shared";

/**
 * Public details for a fund's donation link (no sign-in). Only what a donor
 * needs: the fund's name, its tracking code and how to pay.
 */
export const GET = handle(async (_req: Request, ctx: Ctx<{ slug: string }>) => {
  const { slug } = await ctx.params;
  const { db, fund, ngo, code } = givableFund(slug);
  // The fund's own PayPal account: donations go there. Only its public client ID is sent.
  const pp = fundConn(db, fund);
  return json({
    fund: { slug: fund.slug, title: fund.title, region: fund.region, description: fund.description, accent: fund.accent, open: fund.status === "active", code },
    ngo: { name: ngo?.name ?? "", country: ngo?.country ?? "" },
    // merchantId: an account connected by login; PayPal's buttons then pay that merchant through ClearAid's partner app.
    paypal: { live: pp.live, env: pp.env, clientId: pp.live ? pp.clientId : null, merchantId: pp.live && pp.actAs ? pp.actAs : null },
    limits: { min: MIN_GIFT, max: MAX_GIFT },
    // Whether donors may ask for their share of the leftover back when the fund closes.
    returns: Boolean(fund.donorReturns),
  });
});
