import { getDb } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { getSession, HttpError } from "@/lib/session";
import { withdrawalView } from "@/lib/views";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/withdrawals/[id]">) => {
  const { id } = await ctx.params;
  const db = getDb();
  const s = await getSession();
  const w = db.withdrawals.find((x) => x.id === id);
  if (!w || (w.status === "auditing" && s.role === "public")) throw new HttpError(404, "Not found");
  return json(withdrawalView(db, w, s));
});
