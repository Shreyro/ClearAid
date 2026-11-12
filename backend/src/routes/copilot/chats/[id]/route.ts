import { getChat } from "@/lib/rag/chats";
import { type Ctx, handle, json } from "@/lib/http";
import { HttpError, requireNgo } from "@/lib/session";

/** One of your conversations, with every message. */
export const GET = handle(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const me = await requireNgo();
  const c = getChat(me.id, (await ctx.params).id);
  if (!c) throw new HttpError(404, "Conversation not found");
  return json({ id: c.id, title: c.title, messages: c.messages });
});
