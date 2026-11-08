import { getDb } from "@/lib/db";
import { type Ctx, handle, json } from "@/lib/http";
import { requireFundAccess } from "@/lib/session";
import { fundDetail } from "@/lib/views";

export const GET = handle(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const { id } = await ctx.params;
  const { fund, session } = await requireFundAccess(id);
  return json(fundDetail(getDb(), fund, session));
});
