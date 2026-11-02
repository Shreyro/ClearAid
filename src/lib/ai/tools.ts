import { getDb } from "../db";
import { closurePreview, donorImpact, findFund, fundStats } from "../funds";
import { fmt } from "../money";
import { categoryLabel, type Category, type DB, type Withdrawal } from "../types";
import type { AgentTool } from "./agent";

const usd = (c: number) => Math.round(c) / 100;

function publicWithdrawal(db: DB, w: Withdrawal, detail = false) {
  const vendor = db.vendors.find((v) => v.id === w.vendorId);
  const need = findFund(db, w.fundId)?.needs.find((n) => n.id === w.needId);
  const base = {
    id: w.id,
    status: w.status,
    usd: usd(w.amount),
    category: categoryLabel(w.category),
    vendor: vendor?.name,
    purpose: w.purposePublic,
    item: need?.item,
    quantity: w.quantity,
    beneficiaries: w.beneficiaries,
    location: w.location,
    submitted: w.createdAt.slice(0, 10),
    paid: w.paidAt?.slice(0, 10),
    aiRisk: w.audit?.riskScore,
    aiVerdict: w.audit?.verdict,
  };
  if (!detail) return base;
  return {
    ...base,
    auditSummary: w.audit?.summary,
    checks: w.audit?.checks.map((c) => `${c.status.toUpperCase()} ${c.label}: ${c.detail}`),
    receipt: w.audit?.receipt,
    photos: w.audit?.photos.map((p) => ({ depicts: p.depicts, matchesClaim: p.matchesClaim, concerns: p.concerns })),
    approvals: w.approvals.map((a) => `${a.decision} by ${a.name} on ${a.at.slice(0, 10)}${a.note ? ` (${a.note})` : ""}`),
    paypalPayoutBatch: w.payout?.batchId,
  };
}

export function fundOverview(db: DB, idOrSlug: string) {
  const fund = findFund(db, idOrSlug);
  if (!fund) throw new Error(`No fund "${idOrSlug}"`);
  const s = fundStats(db, fund);
  return {
    id: fund.id,
    slug: fund.slug,
    title: fund.title,
    status: fund.status,
    region: fund.region,
    started: fund.startedAt.slice(0, 10),
    goalUsd: usd(fund.goal),
    raisedUsd: usd(s.raised),
    spentUsd: usd(s.spent),
    balanceUsd: usd(s.balance),
    refundedUsd: usd(s.refunded),
    donors: s.donors,
    peopleReached: s.beneficiaries,
    spendByCategoryUsd: Object.fromEntries(Object.entries(s.byCategory).map(([k, v]) => [categoryLabel(k as Category), usd(v ?? 0)])),
    needs: fund.needs.map((n) => `${n.item}: ${n.fulfilledQty}/${n.targetQty} ${n.unit}`),
    pendingRequests: s.pending,
    rejectedRequests: s.flagged,
    transparencyScore: s.transparency,
    ledgerIntegrity: s.chainValid ? "hash chain verified" : "HASH CHAIN BROKEN",
    policy: {
      dualApprovalAtUsd: usd(fund.policy.dualApprovalThreshold),
      maxSingleWithdrawalUsd: usd(fund.policy.maxSingleWithdrawal),
      categoryCapsPct: fund.policy.categoryCaps,
      leftoverDefault: fund.policy.leftoverDefault,
    },
    closure: fund.status === "closing" ? closurePreview(db, fund) : undefined,
  };
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

export function readTools(opts: { donorId?: string; includePending: boolean }): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: "list_funds",
      description: "List all relief funds on ClearAid with their status and headline totals.",
      input_schema: obj({}),
      run: async () => {
        const db = getDb();
        return db.funds.map((f) => {
          const s = fundStats(db, f);
          return { id: f.id, slug: f.slug, title: f.title, status: f.status, raised: fmt(s.raised), balance: fmt(s.balance) };
        });
      },
    },
    {
      name: "get_fund_overview",
      description: "Totals, spending by category, needs progress, policy and integrity status for one fund.",
      input_schema: obj({ fund: { type: "string", description: "Fund id or slug" } }, ["fund"]),
      run: async (i) => fundOverview(getDb(), String(i.fund)),
    },
    {
      name: "search_spending",
      description:
        "Search a fund's withdrawal requests (vendor payments). Filter by category, vendor name, status or free text. Returns public, PII-redacted records.",
      input_schema: obj(
        {
          fund: { type: "string", description: "Fund id or slug" },
          category: { type: "string", description: "Category id: food, water, shelter, medical, hygiene, logistics, cash_aid, admin" },
          vendor: { type: "string" },
          status: { type: "string", enum: ["paid", "pending_approval", "rejected", "any"] },
          text: { type: "string" },
        },
        ["fund"],
      ),
      run: async (i) => {
        const db = getDb();
        const fund = findFund(db, String(i.fund));
        if (!fund) throw new Error("Unknown fund");
        const status = (i.status as string) || "any";
        return db.withdrawals
          .filter((w) => w.fundId === fund.id)
          .filter((w) => (opts.includePending ? true : w.status !== "auditing"))
          .filter((w) => status === "any" || w.status === status)
          .filter((w) => !i.category || w.category === i.category)
          .filter((w) => !i.vendor || db.vendors.find((v) => v.id === w.vendorId)?.name.toLowerCase().includes(String(i.vendor).toLowerCase()))
          .filter((w) => !i.text || w.purposePublic.toLowerCase().includes(String(i.text).toLowerCase()))
          .map((w) => publicWithdrawal(db, w));
      },
    },
    {
      name: "get_spending_detail",
      description: "Full public audit record for one withdrawal: AI audit summary, every check, receipt line items, photo findings, approvals and the PayPal payout reference.",
      input_schema: obj({ withdrawal_id: { type: "string" } }, ["withdrawal_id"]),
      run: async (i) => {
        const db = getDb();
        const w = db.withdrawals.find((x) => x.id === i.withdrawal_id);
        if (!w) throw new Error("Unknown withdrawal id");
        return publicWithdrawal(db, w, true);
      },
    },
    {
      name: "get_ledger",
      description: "Most recent public ledger entries (donations, payouts, refunds, carry-forwards) for a fund, newest first.",
      input_schema: obj({ fund: { type: "string" }, limit: { type: "number" } }, ["fund"]),
      run: async (i) => {
        const db = getDb();
        const fund = findFund(db, String(i.fund));
        if (!fund) throw new Error("Unknown fund");
        return db.ledger
          .filter((l) => l.fundId === fund.id)
          .slice(-Math.min(Number(i.limit) || 25, 100))
          .reverse()
          .map((l) => ({ seq: l.seq, date: l.ts.slice(0, 10), type: l.type, usd: usd(l.amount), memo: l.memo, by: l.actor, paypalRef: l.paypalRef }));
      },
    },
  ];
  if (opts.donorId) {
    const donorId = opts.donorId;
    tools.push({
      name: "get_my_impact",
      description: "The signed-in donor's own gifts: how each was spent (pro-rata share of each vendor payment), units delivered, refunds and unspent balance.",
      input_schema: obj({}),
      run: async () => donorImpact(getDb(), donorId),
    });
  }
  return tools;
}
