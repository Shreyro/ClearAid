import { askClearAid } from "@/lib/ai/agents";
import { getDb } from "@/lib/db";
import { findFund } from "@/lib/funds";
import { handle, json } from "@/lib/http";
import { getSession, HttpError } from "@/lib/session";

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/funds/[id]/ask">) => {
  const { id } = await ctx.params;
  const fund = findFund(getDb(), id);
  if (!fund) throw new HttpError(404, "Fund not found");
  const { message, conversationId } = (await req.json()) as { message: string; conversationId?: string };
  if (!message?.trim()) throw new Error("Ask a question");
  const s = await getSession();
  return json(
    await askClearAid({
      owner: `${s.role}:${s.id ?? "anon"}`,
      fundId: fund.id,
      donorId: s.role === "donor" ? s.id : undefined,
      message: message.slice(0, 2000),
      conversationId,
    }),
  );
});
