import { controlsOf } from "@/lib/banking";
import { getDb } from "@/lib/db";
import { buildFlow } from "@/lib/flow";
import { type Ctx, handle, json } from "@/lib/http";
import { requireFundAccess, requireNgo } from "@/lib/session";

/** Where one fund's money came from and where it went, plus how much of its bank spending has a receipt. */
export const GET = handle(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const { id } = await ctx.params;
  const me = await requireNgo();
  const { fund } = await requireFundAccess(id);
  const db = getDb();
  const flow = buildFlow(db, [fund], { ngoId: me.ngoId, includeUntraced: false, payeeLimit: 10 });
  const threshold = controlsOf(db, me.ngoId).receiptThreshold;
  const payments = db.bankTxns.filter((t) => t.amount < 0 && !t.isFee && t.allocations.some((a) => a.fundId === fund.id));
  const paid = db.withdrawals.filter((w) => w.fundId === fund.id && w.status === "paid");
  // Declared payments always carry their receipt; their bank line (if any) is matched, not counted again.
  const declared = (db.payments ?? []).filter((p) => p.fundId === fund.id && p.status !== "void");
  const evidence = {
    payments: payments.length + paid.length + declared.length,
    withReceipt: payments.filter((t) => t.receipts?.length).length + paid.filter((w) => w.receiptFileIds.length).length + declared.filter((p) => p.receipt).length,
    missingAboveThreshold: payments.filter((t) => Math.abs(t.amount) >= threshold && !t.receipts?.length).length,
    threshold,
  };
  return json({ ...flow, evidence });
});
