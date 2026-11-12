import { deleteChat, listChats, renameChat } from "@/lib/rag/chats";
import { handle, json } from "@/lib/http";
import { HttpError, requireNgo } from "@/lib/session";

/** The signed-in person's own Copilot conversations (never anyone else's). */
export const GET = handle(async () => {
  const me = await requireNgo();
  return json({ chats: listChats(me.id) });
});

/** Rename or delete one of your conversations. */
export const POST = handle(async (req: Request) => {
  const me = await requireNgo();
  const b = (await req.json().catch(() => ({}))) as { action?: string; id?: string; title?: string };
  if (!b.id) throw new HttpError(400, "Which conversation?");
  if (b.action === "delete") {
    if (!deleteChat(me.id, b.id)) throw new HttpError(404, "Conversation not found");
    return json({ message: "Conversation deleted" });
  }
  if (b.action === "rename") {
    if (!b.title?.trim()) throw new HttpError(400, "Give it a title");
    if (!renameChat(me.id, b.id, b.title)) throw new HttpError(404, "Conversation not found");
    return json({ message: "Renamed" });
  }
  throw new HttpError(400, "Unknown action");
});
