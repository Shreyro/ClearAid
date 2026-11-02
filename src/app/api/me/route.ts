import { getDb } from "@/lib/db";
import { donorImpact } from "@/lib/funds";
import { handle, json } from "@/lib/http";
import { requireRole } from "@/lib/session";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const s = await requireRole("donor");
  const db = getDb();
  return json({
    impact: donorImpact(db, s.id!),
    activeFunds: db.funds.filter((f) => f.status === "active").map((f) => ({ id: f.id, title: f.title, slug: f.slug })),
  });
});
