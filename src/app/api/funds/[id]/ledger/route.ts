import { getDb } from "@/lib/db";
import { findFund } from "@/lib/funds";
import { handle, json } from "@/lib/http";
import { verifyChain } from "@/lib/ledger";
import { HttpError } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The full public, hash-chained ledger. Anyone can re-verify it. */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/funds/[id]/ledger">) => {
  const { id } = await ctx.params;
  const db = getDb();
  const fund = findFund(db, id);
  if (!fund) throw new HttpError(404, "Fund not found");
  const entries = db.ledger.filter((l) => l.fundId === fund.id);
  return json({ fundId: fund.id, algorithm: "sha256(seq|fundId|ts|type|amount|memo|actor|ref|paypalRef|prevHash)", verification: verifyChain(entries), entries });
});
