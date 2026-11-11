import { categoryLabel, type Category, type DB, type Fund } from "./types";

/**
 * Where money came from and where it went, for a set of funds.
 *
 * Three columns: sources (PayPal, each bank account, staff-recorded receipts,
 * carry-ins) → funds (plus an "untraced" pot for bank lines with no tracking
 * code) → destinations (spend category or payee, refunds, carry-outs, and
 * what's still held). Values are cents, always positive.
 *
 * PayPal / manual / carry movements come from the hash-chained fund ledgers.
 * Bank movements come from each bank line's *current* allocation, which is the
 * net of the ledger's bank_in / bank_out entries after any retags.
 */

export type FlowNode = { id: string; label: string; column: 0 | 1 | 2; kind: "source" | "fund" | "untraced" | "dest"; color?: string; slug?: string };
export type FlowLink = { source: string; target: string; value: number };
export type Party = { name: string; total: number; count: number; funds: string[]; via: string };

const UNTRACED = "fund:untraced";

/** A readable name for the other side of a bank line: the counterparty, or the description without rail prefixes and tracking codes. */
export function bankParty(t: { counterparty?: string; description: string }) {
  if (t.counterparty?.trim()) return t.counterparty.trim();
  const d = t.description
    .replace(/#[A-Za-z][A-Za-z0-9]{1,11}(?:-[A-Za-z]{2,8})?/g, "")
    .replace(/^\s*(NEFT|RTGS|IMPS|UPI|ACH|WIRE|SWIFT|POS|ATM|BACS|FPS|CHQ)\b\s*(?:(?:CR|DR)\b)?[\s:/-]*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return (d || t.description.trim()).slice(0, 60);
}
const BALANCE = "dst:balance";

export function buildFlow(db: DB, funds: Fund[], opts: { ngoId: string; includeUntraced: boolean; payeeLimit?: number }) {
  const ids = new Set(funds.map((f) => f.id));
  const nodes = new Map<string, FlowNode>();
  const node = (n: FlowNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return n.id;
  };
  for (const f of funds) node({ id: `fund:${f.id}`, label: f.title, column: 1, kind: "fund", color: f.accent, slug: f.slug });

  const inLinks = new Map<string, number>(); // "src|fund"
  const outCat = new Map<string, number>(); // "fund|dst"
  const outPayee = new Map<string, number>(); // "fund|payee name"
  const sources = new Map<string, Party>();
  const payees = new Map<string, Party>();
  const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  const party = (m: Map<string, Party>, name: string, value: number, fundTitle: string, via: string) => {
    const p = m.get(name) ?? { name, total: 0, count: 0, funds: [], via };
    p.total += value;
    p.count += 1;
    if (!p.funds.includes(fundTitle)) p.funds.push(fundTitle);
    m.set(name, p);
  };
  const title = (fundId: string) => funds.find((f) => f.id === fundId)?.title ?? "Untraced";

  const income = (srcId: string, srcLabel: string, fundNode: string, value: number, payer: string, fundTitle: string) => {
    node({ id: srcId, label: srcLabel, column: 0, kind: "source" });
    bump(inLinks, `${srcId}|${fundNode}`, value);
    party(sources, payer, value, fundTitle, srcLabel);
  };
  const spend = (fundNode: string, dstId: string, dstLabel: string, payee: string | null, value: number, fundTitle: string, via: string) => {
    node({ id: dstId, label: dstLabel, column: 2, kind: "dest" });
    bump(outCat, `${fundNode}|${dstId}`, value);
    bump(outPayee, `${fundNode}|${payee ?? dstLabel}`, value);
    if (payee) party(payees, payee, value, fundTitle, via);
  };
  const catDest = (c?: Category) => (c ? { id: `dst:cat:${c}`, label: categoryLabel(c) } : { id: "dst:cat:none", label: "Uncategorised spend" });

  // ---- Fund ledgers: PayPal donations, staff-recorded receipts, payouts, refunds, carries.
  for (const e of db.ledger) {
    if (!ids.has(e.fundId)) continue;
    const fn = `fund:${e.fundId}`;
    const ft = title(e.fundId);
    const v = Math.abs(e.amount);
    if (!v) continue;
    if (e.type === "donation") {
      const manual = e.paypalRef?.startsWith("MANUAL-");
      income(manual ? "src:manual" : "src:paypal", manual ? "Recorded by staff" : "PayPal donations", fn, v, e.actor || "Anonymous", ft);
    } else if (e.type === "carry_forward_in") {
      income("src:carry", "Carried in from other funds", fn, v, e.memo.match(/from "(.+)"/)?.[1] ?? "Another fund", ft);
    } else if (e.type === "withdrawal") {
      const w = db.withdrawals.find((x) => x.id === e.ref);
      const vendor = w && db.vendors.find((x) => x.id === w.vendorId);
      const d = catDest(w?.category);
      spend(fn, d.id, d.label, vendor?.name ?? e.actor, v, ft, "PayPal Payouts");
    } else if (e.type === "refund") {
      spend(fn, "dst:refund", "Refunded to donors", null, v, ft, "PayPal refund");
    } else if (e.type === "carry_forward_out") {
      spend(fn, "dst:carry", "Carried to other funds", null, v, ft, "Carry forward");
    }
  }

  // ---- Payments staff declared from a receipt (voided ones are left out; their bank line, if any, is matched, not counted).
  for (const p of db.payments ?? []) {
    if (p.status === "void" || !ids.has(p.fundId)) continue;
    const d = catDest(p.category);
    spend(`fund:${p.fundId}`, d.id, d.label, p.publicPayee, p.amount, title(p.fundId), "Declared payment");
  }

  // ---- Bank lines: current allocations (net of retags), plus untraced lines.
  const accounts = new Map(db.bankAccounts.filter((a) => a.ngoId === opts.ngoId).map((a) => [a.id, a]));
  for (const t of db.bankTxns) {
    const acc = accounts.get(t.accountId);
    if (!acc) continue;
    const srcId = `src:bank:${acc.id}`;
    const who = bankParty(t);
    if (t.allocations.length) {
      for (const a of t.allocations) {
        if (!ids.has(a.fundId)) continue;
        const fn = `fund:${a.fundId}`;
        const ft = title(a.fundId);
        if (t.amount >= 0) income(srcId, acc.name, fn, a.amount, who, ft);
        else if (t.isFee) spend(fn, "dst:fees", "Bank fees", null, a.amount, ft, acc.name);
        else {
          const d = catDest(a.category);
          spend(fn, d.id, d.label, who, a.amount, ft, acc.name);
        }
      }
    } else if (opts.includeUntraced) {
      node({ id: UNTRACED, label: "Not yet traced to a fund", column: 1, kind: "untraced" });
      const v = Math.abs(t.amount);
      if (t.amount >= 0) income(srcId, acc.name, UNTRACED, v, who, "Untraced");
      else if (t.isFee) spend(UNTRACED, "dst:fees", "Bank fees", null, v, "Untraced", acc.name);
      else spend(UNTRACED, "dst:untagged", "Untagged payments", who, v, "Untraced", acc.name);
    }
  }

  // ---- What's left in each fund (or how far it's overspent).
  const fundNodes = [...nodes.values()].filter((n) => n.column === 1);
  for (const n of fundNodes) {
    const got = [...inLinks].filter(([k]) => k.endsWith(`|${n.id}`)).reduce((a, [, v]) => a + v, 0);
    const gone = [...outCat].filter(([k]) => k.startsWith(`${n.id}|`)).reduce((a, [, v]) => a + v, 0);
    const left = got - gone;
    if (left > 0) {
      const id = n.kind === "untraced" ? "dst:untraced_balance" : BALANCE;
      const label = n.kind === "untraced" ? "Untraced, still in the bank" : "Still held in funds";
      node({ id, label, column: 2, kind: "dest" });
      bump(outCat, `${n.id}|${id}`, left);
      bump(outPayee, `${n.id}|${label}`, left);
    } else if (left < 0) {
      node({ id: "src:deficit", label: n.kind === "untraced" ? "Paid from untraced money" : "Overspent (out > in)", column: 0, kind: "source" });
      bump(inLinks, `src:deficit|${n.id}`, -left);
    }
  }

  // ---- Payee view: top payees by value, the rest folded into "Other payees".
  const limit = opts.payeeLimit ?? 8;
  const payeeTotals = new Map<string, number>();
  for (const [k, v] of outPayee) {
    const name = k.slice(k.indexOf("|") + 1);
    payeeTotals.set(name, (payeeTotals.get(name) ?? 0) + v);
  }
  const fixedLabels = new Set(["Refunded to donors", "Carried to other funds", "Bank fees", "Still held in funds", "Untraced, still in the bank"]);
  const top = new Set([...payeeTotals].filter(([n]) => !fixedLabels.has(n)).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([n]) => n));
  const payeeLinks = new Map<string, number>();
  const payeeNodes = new Map<string, FlowNode>();
  for (const [k, v] of outPayee) {
    const [from, name] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    const label = fixedLabels.has(name) || top.has(name) ? name : "Other payees";
    const id = `pay:${label}`;
    payeeNodes.set(id, { id, label, column: 2, kind: "dest" });
    bump(payeeLinks, `${from}|${id}`, v);
  }

  const toLinks = (m: Map<string, number>) =>
    [...m].filter(([, v]) => v > 0).map(([k, value]) => ({ source: k.slice(0, k.indexOf("|")), target: k.slice(k.indexOf("|") + 1), value }));
  const leftNodes = [...nodes.values()].filter((n) => n.column !== 2);
  const catNodes = [...nodes.values()].filter((n) => n.column === 2);
  const byValue = (a: Party, b: Party) => b.total - a.total;

  return {
    category: { nodes: [...leftNodes, ...catNodes], links: [...toLinks(inLinks), ...toLinks(outCat)] },
    payee: { nodes: [...leftNodes, ...payeeNodes.values()], links: [...toLinks(inLinks), ...toLinks(payeeLinks)] },
    sources: [...sources.values()].sort(byValue),
    payees: [...payees.values()].sort(byValue),
  };
}
