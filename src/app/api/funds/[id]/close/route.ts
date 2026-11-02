import { getDb } from "@/lib/db";
import { findFund, finalizeClosure, startClosure } from "@/lib/funds";
import { handle, json } from "@/lib/http";
import { ngoAdmin, requireRole, HttpError } from "@/lib/session";

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/funds/[id]/close">) => {
  const s = await requireRole("ngo");
  const admin = ngoAdmin(s.id)!;
  const { id } = await ctx.params;
  const fund = findFund(getDb(), id);
  if (!fund) throw new HttpError(404, "Fund not found");
  const { action } = (await req.json()) as { action: "start" | "finalize" };
  if (action === "start") {
    startClosure(fund.id, admin.ngoName);
    return json({ ok: true, status: "closing" });
  }
  if (action === "finalize") return json({ ok: true, status: "closed", ...(await finalizeClosure(fund.id, admin.ngoName)) });
  throw new Error("Unknown action");
});
