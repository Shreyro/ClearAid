import { getDb } from "@/lib/db";
import { generateInsights } from "@/lib/ai/insights";
import { findFund } from "@/lib/funds";
import { handle, json } from "@/lib/http";
import { HttpError } from "@/lib/session";

export const dynamic = "force-dynamic";

async function load(id: string, force: boolean) {
  const fund = findFund(getDb(), id);
  if (!fund) throw new HttpError(404, "Fund not found");
  const fresh = fund.insights && Date.now() - Date.parse(fund.insights.generatedAt) < 60_000;
  if (fund.insights && (!force || fresh)) return fund.insights;
  return generateInsights(fund.id);
}

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/funds/[id]/insights">) => json(await load((await ctx.params).id, false)));
export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/funds/[id]/insights">) => json(await load((await ctx.params).id, true)));
