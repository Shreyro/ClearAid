import { draftFund } from "@/lib/ai/insights";
import { handle, json } from "@/lib/http";
import { requireRole } from "@/lib/session";

export const POST = handle(async (req: Request) => {
  await requireRole("ngo");
  const { brief } = (await req.json()) as { brief: string };
  if (!brief?.trim()) throw new Error("Describe the crisis first");
  return json(await draftFund(brief.slice(0, 4000)));
});
