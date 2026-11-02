import { publish } from "@/lib/events";
import { setElection } from "@/lib/funds";
import { handle, json } from "@/lib/http";
import { requireRole } from "@/lib/session";

export const POST = handle(async (req: Request) => {
  const s = await requireRole("donor");
  const { fundId, choice, targetFundId } = (await req.json()) as { fundId: string; choice: "refund" | "carry_forward"; targetFundId?: string };
  if (choice !== "refund" && choice !== "carry_forward") throw new Error("Choose refund or carry forward");
  const n = setElection(s.id!, fundId, choice, targetFundId);
  publish({ kind: "fund", fundId });
  return json({ ok: true, donations: n });
});
