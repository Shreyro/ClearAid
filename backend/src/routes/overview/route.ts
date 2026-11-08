import { verifyAuditChain } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { buildFlow } from "@/lib/flow";
import { fundStats } from "@/lib/funds";
import { handle, json } from "@/lib/http";
import { movementView } from "@/lib/movements";
import { getSession, requireNgo, visibleFunds } from "@/lib/session";

/**
 * The money-flow overview: where money came from, which fund it went to and
 * where it went next, for the funds this member can see.
 */
export const GET = handle(async () => {
  const me = await requireNgo();
  const db = getDb();
  const funds = visibleFunds(db, await getSession());
  const ids = new Set(funds.map((f) => f.id));
  const titles = new Map(funds.map((f) => [f.id, f.title]));

  const perFund = funds.map((f) => {
    const st = fundStats(db, f);
    return {
      id: f.id,
      slug: f.slug,
      title: f.title,
      status: f.status,
      accent: f.accent,
      codes: f.trackingCodes ?? [],
      received: st.raised,
      spent: st.spent,
      returned: st.refunded + st.carriedOut,
      balance: st.balance,
      chainValid: st.chainValid,
    };
  });
  const sum = (k: "received" | "spent" | "returned" | "balance") => perFund.reduce((a, f) => a + f[k], 0);

  // Bank lines with no tracking code: money that can't yet be traced to a fund.
  const accounts = new Set(db.bankAccounts.filter((a) => a.ngoId === me.ngoId).map((a) => a.id));
  const untagged = db.bankTxns.filter((t) => accounts.has(t.accountId) && t.status === "untagged");
  const untaggedIn = untagged.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
  const untaggedOut = untagged.filter((t) => t.amount < 0).reduce((a, t) => a - t.amount, 0);

  const flow = buildFlow(db, funds, { ngoId: me.ngoId, includeUntraced: true });
  const auditChain = verifyAuditChain(db.auditLog);

  const recent = db.ledger
    .filter((e) => ids.has(e.fundId) && e.amount !== 0)
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 10)
    .map((e) => movementView(db, e, titles.get(e.fundId)!));

  return json({
    totals: {
      received: sum("received"),
      spent: sum("spent"),
      returned: sum("returned"),
      balance: sum("balance"),
      untagged: { count: untagged.length, in: untaggedIn, out: untaggedOut },
    },
    integrity: {
      ledgers: perFund.length,
      brokenLedgers: perFund.filter((f) => !f.chainValid).map((f) => f.title),
      auditValid: auditChain.valid,
      auditEntries: auditChain.length,
    },
    funds: perFund,
    flow: { category: flow.category, payee: flow.payee },
    sources: flow.sources.slice(0, 8),
    payees: flow.payees.slice(0, 8),
    recent,
    timeline: db.ledger.filter((e) => ids.has(e.fundId)).map((e) => ({ ts: e.ts, type: e.type, amount: e.amount })),
    timelineStart: funds.reduce((a, f) => (f.startedAt < a ? f.startedAt : a), new Date().toISOString()),
  });
});
