import { getDb } from "@/lib/db";
import { findFund } from "@/lib/funds";
import { handle, json } from "@/lib/http";
import { getSession, HttpError } from "@/lib/session";
import { fundDetail } from "@/lib/views";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/funds/[id]">) => {
  const { id } = await ctx.params;
  const db = getDb();
  const fund = findFund(db, id);
  if (!fund) throw new HttpError(404, "Fund not found");
  return json(fundDetail(db, fund, await getSession()));
});
