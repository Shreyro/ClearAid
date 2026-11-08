import { ngoCopilot } from "@/lib/ai/agents";
import { handle, json } from "@/lib/http";
import { requireNgo } from "@/lib/session";

export const POST = handle(async (req: Request) => {
  const admin = await requireNgo();
  const b = (await req.json()) as { message?: string; conversationId?: string; confirm?: boolean };
  return json(await ngoCopilot({ admin, message: b.message?.slice(0, 4000), conversationId: b.conversationId, confirm: b.confirm }));
});
