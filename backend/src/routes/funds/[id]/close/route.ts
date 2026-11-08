import { audit } from "@/lib/audit";
import { getDb, mutate } from "@/lib/db";
import { fmt } from "@/lib/money";
import { findFund, finalizeClosure, startClosure } from "@/lib/funds";
import { type Ctx, handle, json } from "@/lib/http";
import { requireNgoAdmin, HttpError } from "@/lib/session";

export const POST = handle(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const admin = await requireNgoAdmin();
  const { id } = await ctx.params;
  const fund = findFund(getDb(), id);
  if (!fund) throw new HttpError(404, "Fund not found");
  const { action } = (await req.json()) as { action: "start" | "finalize" };
  if (action === "start") {
    startClosure(fund.id, admin.ngoName);
    mutate((db) => audit(db, { actor: admin, action: "fund.closing_started", fundId: fund.id, targetId: fund.id, summary: `Started closing ${fund.title}` }));
    return json({ ok: true, status: "closing" });
  }
  if (action === "finalize") {
    const r = await finalizeClosure(fund.id, admin.ngoName);
    mutate((db) =>
      audit(db, {
        actor: admin,
        action: "fund.closed",
        fundId: fund.id,
        targetId: fund.id,
        summary: `Closed ${fund.title}: ${fmt(r.refunded ?? 0)} refunded to ${r.refunds ?? 0} donors, ${fmt(r.carried ?? 0)} carried forward${r.errors?.length ? `, ${r.errors.length} refund errors` : ""}`,
        meta: { refunded: r.refunded ?? 0, carried: r.carried ?? 0, errors: r.errors?.length ?? 0 },
      }),
    );
    return json({ ok: true, status: "closed", ...r });
  }
  throw new Error("Unknown action");
});
