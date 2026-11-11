import { decideWithdrawal } from "@/lib/withdrawals";
import { type Ctx, handle, json } from "@/lib/http";
import { requireNgo } from "@/lib/session";

export const POST = handle(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const admin = await requireNgo();
  const { id } = await ctx.params;
  const { decision, note } = (await req.json()) as { decision: "approve" | "reject"; note?: string };
  if (decision !== "approve" && decision !== "reject") throw new Error("decision must be approve or reject");
  return json(await decideWithdrawal(id, admin, decision, note?.slice(0, 300)));
});
