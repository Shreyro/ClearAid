import { getDb } from "@/lib/db";
import { ALL_FUNDS, cleanPublish, payloadFor } from "@/lib/embed";
import { handle, json } from "@/lib/http";
import { HttpError, requireNgoAdmin } from "@/lib/session";

/**
 * Exactly what the public would receive for these settings, before anything is
 * published (admins). Built by the same code as the public response.
 */
export const POST = handle(async (req: Request) => {
  const admin = await requireNgoAdmin();
  const b = (await req.json()) as { allFunds?: boolean; fundIds?: string[]; fundId?: string; publish?: unknown };
  const db = getDb();
  const sel = b.allFunds ? { fundId: ALL_FUNDS } : { fundId: b.fundIds?.[0] ?? b.fundId ?? "", fundIds: b.fundIds };
  const payload = payloadFor(db, admin.ngoId, sel, cleanPublish(b.publish));
  if (!payload) throw new HttpError(400, "Tick at least one fund to publish");
  return json(payload);
});
