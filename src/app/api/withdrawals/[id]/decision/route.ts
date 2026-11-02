import { decideWithdrawal } from "@/lib/ai/agents";
import { handle, json } from "@/lib/http";
import { ngoAdmin, requireRole } from "@/lib/session";

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/withdrawals/[id]/decision">) => {
  const s = await requireRole("ngo");
  const admin = ngoAdmin(s.id)!;
  const { id } = await ctx.params;
  const { decision, note } = (await req.json()) as { decision: "approve" | "reject"; note?: string };
  if (decision !== "approve" && decision !== "reject") throw new Error("decision must be approve or reject");
  return json(await decideWithdrawal(id, admin, decision, note?.slice(0, 300)));
});
