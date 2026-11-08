import { getDb } from "@/lib/db";
import { type Ctx, handle, json } from "@/lib/http";
import { HttpError, requireFundAccess } from "@/lib/session";
import { withdrawalView } from "@/lib/views";

export const GET = handle(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const { id } = await ctx.params;
  const db = getDb();
  const w = db.withdrawals.find((x) => x.id === id);
  if (!w) throw new HttpError(404, "Not found");
  const { session } = await requireFundAccess(w.fundId);
  return json(withdrawalView(db, w, session));
});
