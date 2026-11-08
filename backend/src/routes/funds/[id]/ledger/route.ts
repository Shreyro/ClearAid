import { getDb } from "@/lib/db";
import { type Ctx, handle, json } from "@/lib/http";
import { verifyChain } from "@/lib/ledger";
import { requireFundAccess } from "@/lib/session";

/** The fund's full hash-chained ledger. Staff can re-verify it in the browser. */
export const GET = handle(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const { id } = await ctx.params;
  const db = getDb();
  const { fund } = await requireFundAccess(id);
  const entries = db.ledger.filter((l) => l.fundId === fund.id);
  return json({ fundId: fund.id, algorithm: "sha256(seq|fundId|ts|type|amount|memo|actor|ref|paypalRef|prevHash)", verification: verifyChain(entries), entries });
});
