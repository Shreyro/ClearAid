import { audit } from "@/lib/audit";
import { CODE_RE, normaliseCode, rescanUntagged } from "@/lib/banking";
import { announce } from "../bank/shared";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { publish } from "@/lib/events";
import { handle, json } from "@/lib/http";
import { appendLedger } from "@/lib/ledger";
import { fmt, toCents } from "@/lib/money";
import { getSession, requireNgoAdmin, visibleFunds } from "@/lib/session";
import type { Category, Fund } from "@/lib/types";
import { fundCard } from "@/lib/views";

/** Funds the signed-in member can see: all of them for admins, assigned ones for staff. */
export const GET = handle(async () => {
  const db = getDb();
  const cards = visibleFunds(db, await getSession()).map((f) => fundCard(db, f));
  const totals = cards.reduce(
    (a, c) => ({ raised: a.raised + c.raised, spent: a.spent + c.spent, donors: a.donors + c.donors, beneficiaries: a.beneficiaries + c.beneficiaries }),
    { raised: 0, spent: 0, donors: 0, beneficiaries: 0 },
  );
  const ids = new Set(cards.map((c) => c.id));
  const ws = db.withdrawals.filter((w) => ids.has(w.fundId));
  return json({
    funds: cards,
    totals: { ...totals, verifiedPayments: ws.filter((w) => w.status === "paid").length, rejected: ws.filter((w) => w.status === "rejected").length },
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
  trackingCodes?: string[];
}

export const POST = handle(async (req: Request) => {
  const admin = await requireNgoAdmin();
  const b = (await req.json()) as CreateBody;
  if (!b.title?.trim() || !b.description?.trim()) throw new Error("Title and description are required");
  if (!(b.goalUsd > 0)) throw new Error("Set a fundraising goal");
  const codes = [...new Set((b.trackingCodes ?? []).map(normaliseCode).filter(Boolean))].slice(0, 12);
  for (const c of codes) if (!CODE_RE.test(c)) throw new Error(`"${c}" isn't a valid tracking code: a letter, then 1–11 letters or digits (e.g. RO4)`);
  const fund = mutate((db) => {
    for (const c of codes) {
      const other = db.funds.find((x) => x.ngoId === admin.ngoId && (x.trackingCodes ?? []).includes(c));
      if (other) throw new Error(`#${c} is already used by ${other.title}`);
    }
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
      // The creator approves first; a second approver must be assigned before dual-approval withdrawals can clear.
      assignees: [admin.id],
      trackingCodes: codes,
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
    audit(db, { actor: admin, action: "fund.created", fundId: f.id, targetId: f.id, summary: `Created fund "${f.title}" (goal ${fmt(f.goal)}, dual approval from ${fmt(f.policy.dualApprovalThreshold)}, max single ${fmt(f.policy.maxSingleWithdrawal)})`, meta: { goal: f.goal, dualApproval: f.policy.dualApprovalThreshold, maxSingle: f.policy.maxSingleWithdrawal, fastLane: f.policy.fastLaneMax } });
    audit(db, { actor: admin, action: "assignment.added", fundId: f.id, targetId: admin.id, summary: `Assigned ${admin.name} as an approver on ${f.title} (fund creator)` });
    if (codes.length) audit(db, { actor: admin, action: "fund.codes_updated", fundId: f.id, targetId: f.id, summary: `Tracking codes for ${f.title}: ${codes.map((c) => `#${c}`).join(", ")}` });
    // Bank lines already waiting with one of these codes are tagged now.
    const scan = codes.length ? rescanUntagged(db, admin.ngoId) : { tagged: 0, entries: [] };
    return { f, entry, scan };
  });
  publish({ kind: "ledger", fundId: fund.f.id, entry: fund.entry });
  announce(fund.scan.entries);
  return json({ id: fund.f.id, slug: fund.f.slug });
});
