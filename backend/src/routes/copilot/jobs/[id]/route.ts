import { getJob } from "@/lib/rag/jobs";
import { type Ctx, handle, json } from "@/lib/http";
import { HttpError, requireNgo } from "@/lib/session";

/** Progress of a Copilot question started with `async: true`: working, done (with the answer) or error. */
export const GET = handle(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const me = await requireNgo();
  const j = getJob(me.id, (await ctx.params).id);
  if (!j) throw new HttpError(404, "That question is no longer being tracked: ask it again");
  if (j.status === "working") return json({ status: "working" });
  if (j.status === "error") return json({ status: "error", error: j.error!.message, code: j.error!.status });
  return json({ status: "done", result: j.result });
});
