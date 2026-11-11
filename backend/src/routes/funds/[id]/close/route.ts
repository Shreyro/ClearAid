import { audit } from "@/lib/audit";
import { getDb, mutate } from "@/lib/db";
import { fmt, toCents } from "@/lib/money";
import { closurePreview, findFund, finalizeClosure, moveLeftover, startClosure, type LeftoverTransfer } from "@/lib/funds";
import { type Ctx, handle, json } from "@/lib/http";
import { requireNgoAdmin, HttpError } from "@/lib/session";

/** Only an admin of the fund's own NGO may close it or move its leftover money. */
async function adminFund(ctx: Ctx<{ id: string }>) {
  const admin = await requireNgoAdmin();
  const { id } = await ctx.params;
  const fund = findFund(getDb(), id);
  if (!fund || fund.ngoId !== admin.ngoId) throw new HttpError(404, "Fund not found");
  return { admin, fund };
}

/** Transfers arrive in dollars from the form; work in cents. Rows left at $0 are ignored. */
function readTransfers(raw: unknown): LeftoverTransfer[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "transfers must be a list");
  return raw
    .map((t) => ({ fundId: String((t as { fundId?: unknown })?.fundId ?? ""), amount: toCents(Number((t as { amountUsd?: unknown })?.amountUsd)) }))
    .filter((t) => t.amount !== 0);
}

export const GET = handle(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const { fund } = await adminFund(ctx);
  return json({ status: fund.status, ...closurePreview(getDb(), fund) });
});

export const POST = handle(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const { admin, fund } = await adminFund(ctx);
  const body = (await req.json()) as { action?: string; transfers?: unknown };
  const titles = (ts: LeftoverTransfer[]) => ts.map((t) => `${fmt(t.amount)} to ${findFund(getDb(), t.fundId)?.title ?? t.fundId}`).join(", ");

  if (body.action === "start") {
    startClosure(fund.id, admin.ngoName);
    mutate((db) => audit(db, { actor: admin, action: "fund.closing_started", fundId: fund.id, targetId: fund.id, summary: `Started closing ${fund.title}` }));
    return json({ ok: true, status: "closing" });
  }

  if (body.action === "finalize") {
    const transfers = readTransfers(body.transfers);
    const r = await finalizeClosure(fund.id, transfers, admin.ngoName);
    mutate((db) =>
      audit(db, {
        actor: admin,
        action: "fund.closed",
        fundId: fund.id,
        targetId: fund.id,
        summary: `Closed ${fund.title}: ${r.moved ? `moved ${titles(transfers)}` : "nothing moved"}; ${fmt(r.held)} stays held on the fund`,
        meta: { moved: r.moved, held: r.held, funds: transfers.length },
      }),
    );
    return json({ ok: true, status: "closed", ...r });
  }

  if (body.action === "move") {
    const transfers = readTransfers(body.transfers);
    const r = await moveLeftover(fund.id, transfers, admin.ngoName);
    mutate((db) =>
      audit(db, {
        actor: admin,
        action: "fund.leftover_moved",
        fundId: fund.id,
        targetId: fund.id,
        summary: `Moved leftover money from ${fund.title}: ${titles(transfers)}; ${fmt(r.held)} still held`,
        meta: { moved: r.moved, held: r.held, funds: transfers.length },
      }),
    );
    return json({ ok: true, ...r });
  }

  throw new HttpError(400, "Unknown action");
});
