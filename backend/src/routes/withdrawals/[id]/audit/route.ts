import { runAudit } from "@/lib/ai/audit";
import { getDb, mutate } from "@/lib/db";
import { publish } from "@/lib/events";
import { after, type Ctx, handle, json } from "@/lib/http";
import { audit } from "@/lib/audit";
import { actorOf, getSession, HttpError, ngoCanSeeFund, requireNgo } from "@/lib/session";

/** Re-run the AI audit (e.g. after adding an API key, or to compare results). */
export const POST = handle(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const me = await requireNgo();
  const { id } = await ctx.params;
  const db = getDb();
  const w = db.withdrawals.find((x) => x.id === id);
  if (!w) throw new HttpError(404, "Unknown withdrawal");
  if (!ngoCanSeeFund(await getSession(), db.funds.find((f) => f.id === w.fundId)!)) throw new HttpError(403, "You are not assigned to this fund");
  if (w.status !== "pending_approval" && w.status !== "auditing") throw new Error(`Cannot re-audit a ${w.status} request`);
  mutate((db2) => {
    w.status = "auditing";
    audit(db2, { actor: actorOf(me), action: "withdrawal.reaudit", fundId: w.fundId, targetId: w.id, summary: "Re-ran the AI and rule audit on a payment request" });
  });
  publish({ kind: "withdrawal", fundId: w.fundId, withdrawalId: w.id, status: "auditing" });
  after(() => runAudit(id));
  return json({ ok: true });
});
