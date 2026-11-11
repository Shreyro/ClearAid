import { audit } from "@/lib/audit";
import { getDb, mutate } from "@/lib/db";
import { publish } from "@/lib/events";
import { findFund } from "@/lib/funds";
import { type Ctx, handle, json } from "@/lib/http";
import { fmt } from "@/lib/money";
import { optInCount, REFUND_WINDOW_DAYS, returnPlan, returnsOf, returnView, sendReturns } from "@/lib/returns";
import { actorOf, HttpError, requireNgoAdmin } from "@/lib/session";

/** Admins of the fund's own NGO only: this shows donors' names and PayPal emails. */
async function adminFund(ctx: Ctx<{ id: string }>) {
  const admin = await requireNgoAdmin();
  const { id } = await ctx.params;
  const fund = findFund(getDb(), id);
  if (!fund || fund.ngoId !== admin.ngoId) throw new HttpError(404, "Fund not found");
  return { admin, fund };
}

const readPrefer = (raw: unknown) => (raw === "payout" ? "payout" : "auto");

/**
 * Donor returns for one fund: whether donors may ask for their share of the
 * leftover back, who asked, what each is owed, and what has been sent.
 */
export const GET = handle(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const { fund } = await adminFund(ctx);
  const db = getDb();
  const prefer = readPrefer(new URL(req.url).searchParams.get("prefer"));
  const plan = returnPlan(db, fund, prefer);
  return json({
    enabled: Boolean(fund.donorReturns),
    status: fund.status,
    optedIn: optInCount(db, fund),
    refundWindowDays: REFUND_WINDOW_DAYS,
    ...plan,
    history: returnsOf(db)
      .filter((r) => r.fundId === fund.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => returnView(db, r)),
  });
});

export const POST = handle(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const { admin, fund } = await adminFund(ctx);
  const b = (await req.json()) as { action?: string; enabled?: boolean; prefer?: string };

  if (b.action === "setting") {
    const enabled = b.enabled === true;
    const res = mutate((db) => {
      const f = findFund(db, fund.id)!;
      if (Boolean(f.donorReturns) === enabled) throw new HttpError(400, "No change");
      if (enabled && f.status === "closed") throw new HttpError(400, "This fund is closed");
      f.donorReturns = enabled;
      const asked = optInCount(db, f);
      audit(db, {
        actor: actorOf(admin),
        action: "fund.donor_returns_changed",
        fundId: f.id,
        targetId: f.id,
        summary: enabled
          ? `Donors giving to ${f.title} can now ask for their share of the leftover back when the fund closes`
          : `Donors giving to ${f.title} can no longer ask for their share of the leftover back${asked ? `; the ${asked} donor${asked === 1 ? "" : "s"} who already asked still get theirs` : ""}`,
      });
      return { asked };
    });
    publish({ kind: "fund", fundId: fund.id });
    return json({
      ok: true,
      enabled,
      message: enabled
        ? "On. The donation link and donate embeds now offer donors their share of the leftover back."
        : `Off. New donors aren't offered it any more.${res.asked ? ` The ${res.asked} donor${res.asked === 1 ? "" : "s"} who already asked still get their share when the fund closes.` : " Leftover money will be moved to other funds or kept, as you decide at closing."}`,
    });
  }

  if (b.action === "send") {
    const r = await sendReturns(fund.id, actorOf(admin), readPrefer(b.prefer));
    const failed = r.results.filter((x) => x.status === "failed");
    return json({
      ok: true,
      ...r,
      message: `${fmt(r.sent)} sent to ${r.results.length - failed.length} donor${r.results.length - failed.length === 1 ? "" : "s"}.${failed.length ? ` ${failed.length} couldn't be sent: ${failed.map((f) => `${f.donor} (${f.error ?? "refused"})`).join("; ")}.` : ""}`,
    });
  }

  throw new HttpError(400, "Unknown action");
});
