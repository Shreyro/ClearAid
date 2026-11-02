import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { publish } from "@/lib/events";
import { handle, json } from "@/lib/http";
import { appendLedger } from "@/lib/ledger";
import { fmt, toCents } from "@/lib/money";
import { ngoAdmin, requireRole } from "@/lib/session";
import type { Category, Fund } from "@/lib/types";
import { fundCard } from "@/lib/views";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const db = getDb();
  const cards = db.funds.map((f) => fundCard(db, f));
  const totals = cards.reduce(
    (a, c) => ({ raised: a.raised + c.raised, spent: a.spent + c.spent, donors: a.donors + c.donors, beneficiaries: a.beneficiaries + c.beneficiaries }),
    { raised: 0, spent: 0, donors: 0, beneficiaries: 0 },
  );
  const paid = db.withdrawals.filter((w) => w.status === "paid");
  return json({
    funds: cards,
    totals: { ...totals, verifiedPayments: paid.length, rejected: db.withdrawals.filter((w) => w.status === "rejected").length },
  });
});

interface CreateBody {
  title: string;
  disaster: string;
  region: string;
  description: string;
  goalUsd: number;
  lat?: number;
  lng?: number;
  needs: { item: string; category: Category; unit: string; targetQty: number; unitCostUsd: number }[];
  categoryCaps: Partial<Record<Category, number>>;
  dualApprovalUsd: number;
  maxSingleUsd: number;
  fastLaneUsd: number;
  leftoverDefault: "refund" | "carry_forward";
  carryForwardFundId?: string;
}

export const POST = handle(async (req: Request) => {
  const s = await requireRole("ngo");
  const admin = ngoAdmin(s.id)!;
  const b = (await req.json()) as CreateBody;
  if (!b.title?.trim() || !b.description?.trim()) throw new Error("Title and description are required");
  if (!(b.goalUsd > 0)) throw new Error("Set a fundraising goal");
  const fund = mutate((db) => {
    const base = b.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "fund";
    let slug = base;
    for (let i = 2; db.funds.some((f) => f.slug === slug); i++) slug = `${base}-${i}`;
    const f: Fund = {
      id: newId("fund"),
      slug,
      ngoId: admin.ngoId,
      title: b.title.trim(),
      disaster: b.disaster?.trim() || b.title.trim(),
      region: b.region?.trim() || "",
      lat: Number(b.lat) || 0,
      lng: Number(b.lng) || 0,
      startedAt: nowIso(),
      description: b.description.trim(),
      goal: toCents(b.goalUsd),
      status: "active",
      policy: {
        categoryCaps: b.categoryCaps ?? {},
        dualApprovalThreshold: toCents(b.dualApprovalUsd || 2500),
        maxSingleWithdrawal: toCents(b.maxSingleUsd || 6000),
        requirePhotos: true,
        fastLaneMax: toCents(b.fastLaneUsd || 0),
        fastLaneMaxRisk: 20,
        leftoverDefault: b.leftoverDefault === "refund" ? "refund" : "carry_forward",
      },
      needs: (b.needs ?? []).map((n) => ({
        id: newId("need"),
        item: n.item,
        category: n.category,
        unit: n.unit,
        targetQty: Math.max(1, Math.round(n.targetQty)),
        unitCost: toCents(n.unitCostUsd),
        fulfilledQty: 0,
      })),
      vendorIds: db.vendors.filter((v) => v.verified && v.ngoId === admin.ngoId).map((v) => v.id),
      carryForwardFundId: b.carryForwardFundId || undefined,
      accent: ["#0f766e", "#4338ca", "#b45309", "#be123c", "#0369a1"][db.funds.length % 5],
    };
    db.funds.push(f);
    const entry = appendLedger(db, {
      fundId: f.id,
      type: "fund_opened",
      amount: 0,
      memo: `Fund opened by ${admin.ngoName}. Goal ${fmt(f.goal)}.`,
      actor: admin.ngoName,
    });
    return { f, entry };
  });
  publish({ kind: "ledger", fundId: fund.f.id, entry: fund.entry });
  return json({ id: fund.f.id, slug: fund.f.slug });
});
