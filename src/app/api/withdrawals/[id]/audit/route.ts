import { after } from "next/server";
import { runAudit } from "@/lib/ai/audit";
import { getDb, mutate } from "@/lib/db";
import { publish } from "@/lib/events";
import { handle, json } from "@/lib/http";
import { requireRole, HttpError } from "@/lib/session";

/** Re-run the AI audit (e.g. after adding an API key, or to compare results). */
export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/withdrawals/[id]/audit">) => {
  await requireRole("ngo");
  const { id } = await ctx.params;
  const w = getDb().withdrawals.find((x) => x.id === id);
  if (!w) throw new HttpError(404, "Unknown withdrawal");
  if (w.status !== "pending_approval" && w.status !== "auditing") throw new Error(`Cannot re-audit a ${w.status} request`);
  mutate(() => {
    w.status = "auditing";
  });
  publish({ kind: "withdrawal", fundId: w.fundId, withdrawalId: w.id, status: "auditing" });
  after(() => runAudit(id));
  return json({ ok: true });
});
