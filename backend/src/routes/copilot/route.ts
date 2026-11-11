import { handle, json } from "@/lib/http";
import { askCopilot, copilotStatus } from "@/lib/rag/copilot";
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
  await requireNgo();
  const b = (await req.json().catch(() => ({}))) as { message?: string; fundId?: string; history?: { role?: string; text?: string }[] };
  const question = b.message?.trim().slice(0, 2000);
  if (!question) throw new HttpError(400, "Ask a question");
  const history = (Array.isArray(b.history) ? b.history : [])
    .filter((m): m is { role: "user" | "assistant"; text: string } => (m.role === "user" || m.role === "assistant") && typeof m.text === "string")
    .slice(-6);
  return json(await askCopilot({ session: await getSession(), question, fundId: b.fundId || undefined, history }));
});
