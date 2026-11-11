import { z } from "zod/v4";
import { aiEnabled } from "../config";
import { getDb, mutate, nowIso } from "../db";
import { findFund, fundStats } from "../funds";
import { fmt } from "../money";
import { CATEGORIES, categoryLabel, type Category, type FundInsights, type FundPolicy, type Need } from "../types";
import { structured } from "./local";

const InsightSchema = z.object({
  headline: z.string().describe("One punchy, factual sentence (max 14 words)"),
  summary: z.string().describe("2-3 sentences on where the money went and what changed recently"),
  highlights: z.array(z.string()).describe("3-4 concrete, number-backed achievements"),
  gaps: z.array(z.string()).describe("Unmet needs or under-funded categories, most urgent first"),
  risks: z.array(z.string()).describe("Integrity or operational risks donors should know about (may be empty)"),
  runwayDays: z.number().nullable().describe("Days the current balance lasts at the 7-day burn rate"),
  donorMessage: z.string().describe("A warm, specific 1-2 sentence message to donors; no fundraising pressure"),
});

function snapshot(fundId: string) {
  const db = getDb();
  const fund = findFund(db, fundId)!;
  const s = fundStats(db, fund);
  const ws = db.withdrawals.filter((w) => w.fundId === fund.id);
  return {
    fund,
    s,
    data: {
      fund: { title: fund.title, disaster: fund.disaster, region: fund.region, startedAt: fund.startedAt.slice(0, 10), status: fund.status, goalUsd: fund.goal / 100 },
      totalsUsd: { raised: s.raised / 100, spent: s.spent / 100, balance: s.balance / 100, refunded: s.refunded / 100, dailyBurn7d: s.dailyBurn / 100 },
      donors: s.donors,
      spendByCategoryUsd: Object.fromEntries(Object.entries(s.byCategory).map(([k, v]) => [categoryLabel(k as Category), (v ?? 0) / 100])),
      needs: fund.needs.map((n) => ({ item: n.item, unit: n.unit, target: n.targetQty, delivered: n.fulfilledQty, pct: Math.round((n.fulfilledQty / n.targetQty) * 100) })),
      recentSpending: ws
        .filter((w) => w.status === "paid")
        .sort((a, b) => (b.paidAt ?? "").localeCompare(a.paidAt ?? ""))
        .slice(0, 15)
        .map((w) => ({ id: w.id, date: w.paidAt?.slice(0, 10), usd: w.amount / 100, category: categoryLabel(w.category), purpose: w.purposePublic, beneficiaries: w.beneficiaries ?? null, risk: w.audit?.riskScore ?? null })),
      flaggedOrRejected: ws.filter((w) => w.status === "rejected").map((w) => ({ id: w.id, usd: w.amount / 100, reason: w.audit?.summary })),
      awaitingApproval: ws.filter((w) => w.status === "pending_approval").length,
      transparencyScore: s.transparency,
      peopleReached: s.beneficiaries,
    },
  };
}

function heuristic(fundId: string): FundInsights {
  const { fund, s } = snapshot(fundId);
  const top = Object.entries(s.byCategory).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
  const lagging = [...fund.needs].sort((a, b) => a.fulfilledQty / a.targetQty - b.fulfilledQty / b.targetQty).slice(0, 3);
  return {
    engine: "heuristic",
    generatedAt: nowIso(),
    headline: `${fmt(s.spent)} deployed to verified vendors, ${fmt(s.balance)} ready for relief`,
    summary: `${s.donors} donors have given ${fmt(s.raised)}. ${top ? `${categoryLabel(top[0] as Category)} is the largest spending area at ${fmt(top[1] ?? 0)}.` : "No spending yet."} ${s.pending} request(s) are awaiting review.`,
    highlights: [
      `${s.paidCount} vendor payments released, each with a receipt and an audit trail`,
      `${s.beneficiaries.toLocaleString()} people reached according to vendor delivery reports`,
      `Transparency score ${s.transparency}/100`,
    ],
    gaps: lagging.map((n) => `${n.item}: ${n.fulfilledQty.toLocaleString()} of ${n.targetQty.toLocaleString()} ${n.unit} delivered`),
    risks: s.flagged ? [`${s.flagged} withdrawal request(s) were rejected after audit`] : [],
    runwayDays: s.runwayDays,
    donorMessage: "Every payment on this page is matched to a receipt and a delivery photo. Thank you for making it possible.",
  };
}

export async function generateInsights(fundId: string): Promise<FundInsights> {
  let out: FundInsights;
  if (!aiEnabled()) out = heuristic(fundId);
  else {
    try {
      const { data } = snapshot(fundId);
      const { data: r } = await structured({
        schema: InsightSchema,
        system:
          "You write the 'Crisis insights' panel on a public disaster-relief fund page. Readers are donors who want to know, in plain language, where their money went, what is still needed and whether anything looks wrong. Use only the data provided; never invent numbers. Prefer specific numbers and items over adjectives. Use US dollars.",
        prompt: `Fund data (JSON):\n${JSON.stringify(data, null, 2)}`,
        maxTokens: 1500,
      });
      out = { engine: "local", generatedAt: nowIso(), ...r };
    } catch {
      out = heuristic(fundId);
    }
  }
  mutate((db) => {
    const f = findFund(db, fundId);
    if (f) f.insights = out;
  });
  return out;
}

// ------------------------------------------------- AI fund setup assistant ----

const DraftSchema = z.object({
  title: z.string().describe("Fund title, e.g. 'Cyclone X — Coastal Recovery Fund'"),
  disaster: z.string().describe("Short name of the event"),
  region: z.string(),
  description: z.string().describe("2-3 sentence public description of what the fund will do"),
  goalUsd: z.number(),
  lat: z.number().describe("Approximate latitude of the affected area"),
  lng: z.number().describe("Approximate longitude of the affected area"),
  needs: z.array(
    z.object({
      item: z.string(),
      category: z.enum(CATEGORIES.map((c) => c.id) as [Category, ...Category[]]),
      unit: z.string(),
      targetQty: z.number(),
      unitCostUsd: z.number().describe("Typical local cost per unit in USD"),
    }),
  ),
  categoryCapsPct: z.array(
    z.object({ category: z.enum(CATEGORIES.map((c) => c.id) as [Category, ...Category[]]), maxPct: z.number() }),
  ),
});

export type FundDraft = {
  title: string;
  disaster: string;
  region: string;
  description: string;
  goal: number;
  lat: number;
  lng: number;
  needs: Omit<Need, "id" | "fulfilledQty">[];
  categoryCaps: FundPolicy["categoryCaps"];
  engine: "local" | "template";
};

export async function draftFund(brief: string): Promise<FundDraft> {
  if (aiEnabled()) {
    try {
      const { data: d } = await structured({
        schema: DraftSchema,
        system:
          "You help NGO staff set up a transparent disaster-relief fund. From a short brief, propose a realistic fund: a public title and description, a USD goal, a needs list (5-8 items) with quantities and typical local unit costs, and per-category spending caps as a % of funds raised (admin should be 5-10%). Ground estimates in typical humanitarian cluster standards (e.g. Sphere) for the region and be conservative.",
        prompt: brief,
        maxTokens: 2500,
      });
      return {
        title: d.title,
        disaster: d.disaster,
        region: d.region,
        description: d.description,
        goal: Math.round(d.goalUsd * 100),
        lat: d.lat,
        lng: d.lng,
        needs: d.needs.map((n) => ({ item: n.item, category: n.category, unit: n.unit, targetQty: Math.round(n.targetQty), unitCost: Math.round(n.unitCostUsd * 100) })),
        categoryCaps: Object.fromEntries(d.categoryCapsPct.map((c) => [c.category, Math.round(c.maxPct)])),
        engine: "local",
      };
    } catch {
      /* fall back to template */
    }
  }
  return {
    title: brief.split(/[.\n]/)[0].slice(0, 80) || "Emergency Relief Fund",
    disaster: "Emergency",
    region: "Affected region",
    description: brief.slice(0, 400),
    goal: 2500000,
    lat: 0,
    lng: 0,
    needs: [
      { item: "Family food ration (7 days)", category: "food", unit: "rations", targetQty: 1000, unitCost: 1800 },
      { item: "Drinking water (20L)", category: "water", unit: "jerrycans", targetQty: 2000, unitCost: 300 },
      { item: "Tarpaulin shelter kit", category: "shelter", unit: "kits", targetQty: 400, unitCost: 2200 },
      { item: "Hygiene kit", category: "hygiene", unit: "kits", targetQty: 800, unitCost: 900 },
      { item: "First-aid & medicines", category: "medical", unit: "kits", targetQty: 150, unitCost: 4500 },
    ],
    categoryCaps: { food: 40, water: 25, shelter: 30, hygiene: 20, medical: 25, logistics: 12, admin: 8 },
    engine: "template",
  };
}
