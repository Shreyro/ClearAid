import { handle, json } from "@/lib/http";
import { askCopilot, copilotStatus } from "@/lib/rag/copilot";
import { getChat, saveTurn } from "@/lib/rag/chats";
import { startJob } from "@/lib/rag/jobs";
import { getSession, HttpError, requireNgo } from "@/lib/session";

/** Model, search status and the funds this person can ask about. */
export const GET = handle(async () => {
  await requireNgo();
  return json(await copilotStatus(await getSession()));
});

/**
 * Ask the local Copilot (Llama via Ollama + FAISS). Admins, staff and donors;
 * what it can draw on is limited to the funds the person may see.
 */
export const POST = handle(async (req: Request) => {
  const me = await requireNgo();
  const b = (await req.json().catch(() => ({}))) as { message?: string; fundId?: string; chatId?: string; async?: boolean };
  const question = b.message?.trim().slice(0, 2000);
  if (!question) throw new HttpError(400, "Ask a question");
  // Memory: earlier turns come from the saved conversation, so follow-ups ("and in March?") make sense.
  const chat = b.chatId ? getChat(me.id, b.chatId) : undefined;
  if (b.chatId && !chat) throw new HttpError(404, "Conversation not found");
  const history = (chat?.messages ?? []).map((m) => ({ role: m.role, text: m.text }));
  const session = await getSession();
  const run = async () => {
    const r = await askCopilot({ session, question, fundId: b.fundId || undefined, history });
    const chatId = saveTurn(me.id, chat?.id, question, { text: r.reply, reply: r });
    return { ...r, chatId };
  };
  // The page asks in the background and polls, so no connection stays open while the model thinks.
  if (b.async) return json({ jobId: startJob(me.id, run) }, 202);
  return json(await run());
});
