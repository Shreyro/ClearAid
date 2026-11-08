import { config, paypalLive } from "@/lib/config";
import { type Ctx, handle, json } from "@/lib/http";
import { givableFund, MAX_GIFT, MIN_GIFT } from "../shared";

/**
 * Public details for a fund's donation link (no sign-in). Only what a donor
 * needs: the fund's name, its tracking code and how to pay.
 */
export const GET = handle(async (_req: Request, ctx: Ctx<{ slug: string }>) => {
  const { slug } = await ctx.params;
  const { fund, ngo, code } = givableFund(slug);
  return json({
    fund: { slug: fund.slug, title: fund.title, region: fund.region, description: fund.description, accent: fund.accent, open: fund.status === "active", code },
    ngo: { name: ngo?.name ?? "", country: ngo?.country ?? "" },
    paypal: { live: paypalLive(), env: config.paypal.env, clientId: paypalLive() ? config.paypal.clientId : null },
    limits: { min: MIN_GIFT, max: MAX_GIFT },
  });
});
