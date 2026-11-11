import { canSeeTxn, controlsOf, missingReceipt } from "../banking";
import { getDb } from "../db";
import { buildFlow, type Party } from "../flow";
import { movementView } from "../movements";
import { closurePreview, donorImpact, findFund, fundStats } from "../funds";
import { fmt } from "../money";
import { type BankTxn, categoryLabel, type Category, type DB, type Withdrawal } from "../types";
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
    },
    closure: fund.status !== "active" ? (({ held, movedOut }) => ({ heldUsd: usd(held), movedToOtherFundsUsd: usd(movedOut) }))(closurePreview(db, fund)) : undefined,
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

/**
 * Tracker tools for the NGO Copilot: where money came from and went, bank
 * lines that still need a tag, approval or receipt. Read-only. There is
 * deliberately no tool that sets or suggests a tracking code.
 */
export function trackerTools(member: { id: string; role: string; ngoId: string }): AgentTool[] {
  const visibleFunds = (db: DB) => db.funds.filter((f) => f.ngoId === member.ngoId && (member.role === "admin" || f.assignees.includes(member.id)));
  const pickFund = (db: DB, v: unknown) => {
    if (!v) return null;
    const f = findFund(db, String(v));
    if (!f || !visibleFunds(db).some((x) => x.id === f.id)) throw new Error(`No fund "${String(v)}" that this person can see`);
    return f;
  };
  return [
    {
      name: "get_money_flow",
      description: "Where money came from and where it went, for one fund or all funds the user can see: totals, top sources (donors, banks) and top payees, plus money not yet traced to a fund.",
      input_schema: obj({ fund: { type: "string", description: "Fund id or slug; omit for all funds" } }),
      run: async (i) => {
        const db = getDb();
        const one = pickFund(db, i.fund);
        const funds = one ? [one] : visibleFunds(db);
        const flow = buildFlow(db, funds, { ngoId: member.ngoId, includeUntraced: !one, payeeLimit: 15 });
        const party = (p: Party) => ({ name: p.name, usd: usd(p.total), count: p.count, via: p.via, funds: p.funds });
        const links = flow.category.links;
        const sum = (pred: (l: (typeof links)[number]) => boolean) => usd(links.filter(pred).reduce((a, l) => a + l.value, 0));
        return {
          scope: one ? one.title : "All funds",
          moneyInUsd: sum((l) => l.source.startsWith("src:")),
          untracedUsd: sum((l) => l.target === "fund:untraced" || l.source === "fund:untraced"),
          sources: flow.sources.slice(0, 15).map(party),
          payees: flow.payees.slice(0, 15).map(party),
        };
      },
    },
    {
      name: "search_transactions",
      description: "Search money movements on the fund ledgers (donations, bank receipts and payments, payouts, refunds, carry-forwards). Each result says from, to, amount, fund and how it moved.",
      input_schema: obj({
        fund: { type: "string", description: "Fund id or slug" },
        direction: { type: "string", enum: ["in", "out", "any"] },
        text: { type: "string", description: "Matches payer/payee, memo, reference or type" },
        from_date: { type: "string", description: "YYYY-MM-DD" },
        to_date: { type: "string", description: "YYYY-MM-DD" },
        min_usd: { type: "number" },
        limit: { type: "number" },
      }),
      run: async (i) => {
        const db = getDb();
        const one = pickFund(db, i.fund);
        const funds = new Map((one ? [one] : visibleFunds(db)).map((f) => [f.id, f.title]));
        const text = i.text ? String(i.text).toLowerCase() : "";
        const rows = db.ledger
          .filter((e) => funds.has(e.fundId) && e.amount !== 0)
          .map((e) => movementView(db, e, funds.get(e.fundId)!))
          .filter((m) => !i.direction || i.direction === "any" || m.direction === i.direction)
          .filter((m) => !i.from_date || m.ts.slice(0, 10) >= String(i.from_date))
          .filter((m) => !i.to_date || m.ts.slice(0, 10) <= String(i.to_date))
          .filter((m) => !i.min_usd || Math.abs(m.amount) >= Number(i.min_usd) * 100)
          .filter((m) => !text || [m.from, m.to, m.memo, m.paypalRef, m.via, m.typeLabel].some((v) => v?.toLowerCase().includes(text)))
          .sort((a, b) => b.ts.localeCompare(a.ts));
        return {
          matches: rows.length,
          totalUsd: usd(rows.reduce((a, m) => a + m.amount, 0)),
          rows: rows.slice(0, Math.min(Number(i.limit) || 25, 100)).map((m) => ({ date: m.ts.slice(0, 10), from: m.from, to: m.to, usd: usd(m.amount), fund: m.fundTitle, type: m.typeLabel, via: m.via, memo: m.memo, ref: m.paypalRef })),
        };
      },
    },
    {
      name: "list_bank_lines",
      description: "Bank lines that need attention: 'untagged' (no fund yet), 'pending' (a manual tag waiting for a second person), 'receipts' (payments above the receipt threshold with no receipt), 'fees' (bank fees not charged to a fund).",
      input_schema: obj({ status: { type: "string", enum: ["untagged", "pending", "receipts", "fees"] }, limit: { type: "number" } }, ["status"]),
      run: async (i) => {
        const db = getDb();
        const accounts = new Set(db.bankAccounts.filter((a) => a.ngoId === member.ngoId).map((a) => a.id));
        const pred: Record<string, (t: BankTxn) => boolean> = {
          untagged: (t) => t.status === "untagged",
          pending: (t) => Boolean(t.pending),
          receipts: (t) => missingReceipt(db, t, member.ngoId),
          fees: (t) => t.status === "fee_unallocated",
        };
        const f = pred[String(i.status)] ?? pred.untagged;
        const rows = db.bankTxns.filter((t) => accounts.has(t.accountId) && canSeeTxn(t, member, db) && f(t));
        return {
          count: rows.length,
          totalUsd: usd(rows.reduce((a, t) => a + t.amount, 0)),
          controls: (({ tagApprovalThreshold, receiptThreshold }) => ({ secondPersonFromUsd: usd(tagApprovalThreshold), receiptFromUsd: usd(receiptThreshold) }))(controlsOf(db, member.ngoId)),
          rows: rows.slice(0, Math.min(Number(i.limit) || 25, 100)).map((t) => ({
            id: t.id,
            date: t.date,
            usd: usd(t.amount),
            description: t.description,
            why: t.untaggedReason,
            fund: t.allocations.map((a) => db.funds.find((x) => x.id === a.fundId)?.title).join(", ") || undefined,
            pending: t.pending ? `${t.pending.byName} wants to ${t.pending.kind}: ${t.pending.reason}` : undefined,
            receipts: t.receipts?.length ?? 0,
          })),
          link: `/untagged?status=${String(i.status)}`,
        };
      },
    },
  ];
}
