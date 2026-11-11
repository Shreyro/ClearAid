import { getDb } from "@/lib/db";
import { buildEmbedPayload, cleanPublish } from "@/lib/embed";
import { handle, json } from "@/lib/http";
import { HttpError, requireNgoAdmin } from "@/lib/session";

/**
 * Exactly what the public would receive for these settings, before anything is
 * published (admins). Built by the same code as the public response.
 */
export const POST = handle(async (req: Request) => {
  const admin = await requireNgoAdmin();
  const b = (await req.json()) as { fundId?: string; publish?: unknown };
  const db = getDb();
  const fund = db.funds.find((f) => f.id === b.fundId && f.ngoId === admin.ngoId);
  if (!fund) throw new HttpError(400, "Choose the fund to publish");
  return json(buildEmbedPayload(db, fund, cleanPublish(b.publish)));
});
