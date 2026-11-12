import { buildFlow } from "../flow";
import { fundStats } from "../funds";
import { fmt } from "../money";
import { movementView } from "../movements";
import { PAYMENT_METHODS } from "../payments";
import { categoryLabel, type DB, type Fund } from "../types";

/**
 * Everything recorded in ClearAid, as short passages the Copilot can search.
 *
 * Passages are grouped into one index per fund and audience:
 *   f:<fundId>:staff   full detail (raw purposes, receipt line items, emails)
 *   f:<fundId>:public  what a donor may read (the same redaction as the screens)
 *   ngo:<ngoId>:untraced  bank lines not on any fund yet (staff only)
 *
 * Which indexes a person may search is decided in ./scope.ts, never here.
 */

export type Doc = { id: string; text: string; meta: { fundId?: string; kind: string; date?: string; href?: string } };
export type Audience = "staff" | "public";

export const fundIndex = (fundId: string, audience: Audience) => `f:${fundId}:${audience}`;
export const untracedIndex = (ngoId: string) => `ngo:${ngoId}:untraced`;

const day = (iso: string) => iso.slice(0, 10);
const money = (cents: number) => fmt(Math.abs(cents));

function fundProfile(db: DB, f: Fund): Doc {
  const ngo = db.ngos.find((n) => n.id === f.ngoId);
  const needs = f.needs.map((n) => `${n.item} (${n.unit}, ${money(n.unitCost)} each, ${n.fulfilledQty} of ${n.targetQty} delivered)`).join("; ");
  const caps = Object.entries(f.policy.categoryCaps ?? {})
    .map(([c, pct]) => `${categoryLabel(c as never)} ≤ ${pct}%`)
    .join(", ");
  return {
    id: `fund:${f.id}`,
    meta: { fundId: f.id, kind: "fund", href: `/funds/${f.slug}` },
    text: [
      `Fund "${f.title}" run by ${ngo?.name ?? "the NGO"}. Status: ${f.status}. Region: ${f.region}. Disaster: ${f.disaster}.`,
      `Started ${day(f.startedAt)}. Goal ${money(f.goal)}. Tracking codes: ${(f.trackingCodes ?? []).map((c) => `#${c}`).join(", ") || "none"}.`,
      f.description,
      needs && `Needs: ${needs}.`,
      caps && `Spending caps: ${caps}.`,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function ledgerDocs(db: DB, f: Fund, audience: Audience): Doc[] {
  return db.ledger
    .filter((e) => e.fundId === f.id)
    .map((e) => {
      const m = movementView(db, e, f.title);
      const dir = m.direction === "in" ? "Money in" : m.direction === "out" ? "Money out" : "Notice";
      const amount = m.amount ? ` ${m.amount > 0 ? "+" : "−"}${money(m.amount)}` : "";
      const email = audience === "staff" && m.counterpartyEmail ? ` (${m.counterpartyEmail})` : "";
      const fromTo = m.direction === "notice" ? "" : ` from ${m.from}${m.direction === "in" ? email : ""} to ${m.to}${m.direction === "out" ? email : ""}.`;
      return {
        id: `led:${f.id}:${e.seq}`,
        meta: { fundId: f.id, kind: "ledger", date: day(e.ts), href: m.detailHref && !m.detailHref.startsWith("/api/") ? m.detailHref : undefined },
        text: `${day(e.ts)} · ${f.title} · ${dir}${amount} · ${m.typeLabel}${m.via ? ` via ${m.via}` : ""}.${fromTo} Memo: ${m.memo}${m.paypalRef ? ` · Ref ${m.paypalRef}` : ""} · Ledger #${e.seq}`,
      };
    });
}

function bankDocs(db: DB, f: Fund, audience: Audience): Doc[] {
  const out: Doc[] = [];
  for (const t of db.bankTxns) {
    const a = t.allocations.find((x) => x.fundId === f.id);
    if (!a) continue;
    const acc = db.bankAccounts.find((x) => x.id === t.accountId);
    const parts = [
      `${t.date} · ${f.title} · Bank ${t.amount < 0 ? (t.isFee ? "fee" : "payment") : "receipt"} ${money(a.amount)}${t.allocations.length > 1 ? ` (split; line total ${money(t.amount)})` : ""} on ${acc?.name ?? "a bank account"}.`,
      `Description: ${t.description}${t.counterparty ? ` · Counterparty: ${t.counterparty}` : ""}.`,
      a.category ? `Category: ${categoryLabel(a.category)}.` : "",
      a.code ? `Tagged by code #${a.code}.` : t.reason ? `Tagged by ${t.taggedByName ?? "staff"}: ${t.reason}.` : "",
    ];
    // Receipts are private files: their contents go to staff only.
    if (audience === "staff") {
      for (const r of t.receipts ?? []) {
        const x = r.extraction;
        if (!x) continue;
        const items = x.lineItems.map((li) => `${li.description}${li.amount != null ? ` ${li.amount}` : ""}`).join("; ");
        parts.push(`Receipt from ${x.supplier ?? "unknown supplier"}${x.invoiceNumber ? `, invoice ${x.invoiceNumber}` : ""}${x.date ? `, dated ${x.date}` : ""}${x.total != null ? `, total ${x.currency ?? ""} ${x.total}` : ""}${items ? `. Items: ${items}` : ""}.`);
      }
    } else if (t.receipts?.length) parts.push("A receipt is on file.");
    out.push({ id: `bank:${t.id}:${f.id}`, meta: { fundId: f.id, kind: "bank", date: t.date }, text: parts.filter(Boolean).join(" ") });
  }
  return out;
}

function paymentDocs(db: DB, f: Fund, audience: Audience): Doc[] {
  return (db.payments ?? [])
    .filter((p) => p.fundId === f.id)
    .map((p) => {
      const staff = audience === "staff";
      const status = { awaiting_bank: "waiting for its bank line", matched: "matched to its bank line", no_bank: "no bank line expected", void: `voided (${p.voidReason ?? ""})` }[p.status];
      const parts = [
        `${p.date} · ${f.title} · Declared payment ${money(p.amount)} to ${staff ? p.payee : p.publicPayee} by ${PAYMENT_METHODS[p.method].toLowerCase()}.`,
        `For: ${staff ? p.description : p.publicDescription}.`,
        p.category ? `Category: ${categoryLabel(p.category)}.` : "",
        p.invoiceNumber ? `Invoice ${p.invoiceNumber}.` : "",
        `Status: ${status}.`,
        staff ? `Recorded by ${p.byName}.` : "",
      ];
      const x = staff ? p.receipt?.extraction : undefined;
      if (x?.lineItems.length) parts.push(`Receipt items: ${x.lineItems.map((li) => `${li.description}${li.amount != null ? ` ${li.amount}` : ""}`).join("; ")}.`);
      return { id: `pay:${p.id}`, meta: { fundId: f.id, kind: "payment", date: p.date }, text: parts.filter(Boolean).join(" ") };
    });
}

function withdrawalDocs(db: DB, f: Fund, audience: Audience): Doc[] {
  return db.withdrawals
    .filter((w) => w.fundId === f.id && (audience === "staff" || w.status !== "auditing"))
    .map((w) => {
      const v = db.vendors.find((x) => x.id === w.vendorId);
      const parts = [
        `${day(w.createdAt)} · ${f.title} · Payment request ${w.id} for ${money(w.amount)} to ${v?.name ?? "a vendor"}${v?.location ? ` (${v.location})` : ""}. Category: ${categoryLabel(w.category)}. Status: ${w.status}${w.paidAt ? `, paid ${day(w.paidAt)}` : ""}.`,
        `Purpose: ${audience === "staff" ? w.purposeRaw : w.purposePublic}.`,
        w.quantity ? `Quantity: ${w.quantity}.` : "",
        w.beneficiaries ? `Beneficiaries: ${w.beneficiaries}.` : "",
        w.location ? `Location: ${w.location}.` : "",
        w.audit ? `Audit (${w.audit.verdict}, risk ${w.audit.riskScore}): ${w.audit.summary}` : "",
      ];
      return { id: `wd:${w.id}`, meta: { fundId: f.id, kind: "request", date: day(w.createdAt), href: `/spend/${w.id}` }, text: parts.filter(Boolean).join(" ") };
    });
}

function untracedDocs(db: DB, ngoId: string): Doc[] {
  const accounts = new Map(db.bankAccounts.filter((a) => a.ngoId === ngoId).map((a) => [a.id, a]));
  return db.bankTxns
    .filter((t) => accounts.has(t.accountId) && (t.status === "untagged" || t.status === "fee_unallocated"))
    .map((t) => ({
      id: `untraced:${t.id}`,
      meta: { kind: "untraced", date: t.date, href: `/untagged?status=all&q=${t.id}` },
      text: `${t.date} · Not on any fund yet · Bank ${t.amount < 0 ? (t.isFee ? "fee" : "payment") : "receipt"} ${money(t.amount)} on ${accounts.get(t.accountId)!.name}. Description: ${t.description}${t.counterparty ? ` · Counterparty: ${t.counterparty}` : ""}. Why: ${t.untaggedReason ?? "no tracking code"}.`,
    }));
}

/** Every index, with its passages. Rebuilt in full; the rag service only re-embeds text that changed. */
export function buildIndexes(db: DB): Record<string, Doc[]> {
  const out: Record<string, Doc[]> = {};
  for (const f of db.funds) {
    for (const audience of ["staff", "public"] as const) {
      out[fundIndex(f.id, audience)] = [fundProfile(db, f), ...ledgerDocs(db, f, audience), ...bankDocs(db, f, audience), ...paymentDocs(db, f, audience), ...withdrawalDocs(db, f, audience)];
    }
  }
  for (const n of db.ngos) out[untracedIndex(n.id)] = untracedDocs(db, n.id);
  return out;
}

/**
 * Exact figures for one fund, worked out from the ledger when the question is
 * asked (search finds passages; totals have to be computed, not guessed).
 */
const pct = (part: number, whole: number) => `${((part / whole) * 100).toFixed(1)}%`;

export function fundSummary(db: DB, f: Fund, audience: Audience) {
  const s = fundStats(db, f);
  const flow = buildFlow(db, [f], { ngoId: f.ngoId, includeUntraced: false, payeeLimit: 12 });
  const label = new Map(flow.category.nodes.map((n) => [n.id, n.label]));
  const byCategory = flow.category.links
    .filter((l) => l.source === `fund:${f.id}` && l.target !== "dst:balance")
    .sort((a, b) => b.value - a.value)
    .map((l) => `${label.get(l.target) ?? l.target} ${money(l.value)}`)
    .join("; ");
  // Money in by channel (PayPal, each bank account, recorded by staff, carried in).
  const byChannel = flow.category.links
    .filter((l) => l.target === `fund:${f.id}`)
    .sort((a, b) => b.value - a.value)
    .map((l) => `${label.get(l.source) ?? l.source} ${money(l.value)}`)
    .join("; ");
  const party = (p: { name: string; total: number; count: number; via: string }) => `  - ${p.name}: ${money(p.total)} in ${p.count} payment${p.count === 1 ? "" : "s"} (${p.via})`;
  const waiting = (db.payments ?? []).filter((p) => p.fundId === f.id && p.status === "awaiting_bank").length;
  // Plain labelled lines: a small local model copies figures reliably but adds them up badly.
  return [
    `=== ${f.title} (status: ${f.status}; tracking codes: ${(f.trackingCodes ?? []).map((c) => `#${c}`).join(" ") || "none"}) ===`,
    `TOTAL MONEY IN: ${money(s.raised)}${byChannel ? ` (by channel: ${byChannel})` : ""}`,
    `TOTAL MONEY OUT (spent): ${money(s.spent)}${byCategory ? ` (by category: ${byCategory})` : ""}`,
    `REFUNDED TO DONORS: ${money(s.refunded)}`,
    `CARRIED TO OTHER FUNDS: ${money(s.carriedOut)}`,
    `BALANCE STILL HELD: ${money(s.balance)} (goal ${money(f.goal)})`,
    // Worked out here so the model copies the percentages instead of dividing.
    f.goal > 0 ? `PROGRESS TO GOAL: raised ${pct(s.raised, f.goal)} of the goal so far; the balance still held is ${pct(s.balance, f.goal)} of the goal` : "",
    `LIFECYCLE: ${f.status === "closing" ? `CLOSING: the fund is winding down${f.closingStartedAt ? ` (started ${f.closingStartedAt.slice(0, 10)})` : ""}` : f.status === "closed" ? "CLOSED" : "ACTIVE: still open and receiving or spending money"}`,
    `NUMBER OF DONORS: ${s.donors}`,
    flow.sources.length ? `LARGEST SOURCES OF MONEY IN:\n${flow.sources.slice(0, 8).map(party).join("\n")}` : "",
    flow.payees.length ? `LARGEST PAYEES (MONEY OUT):\n${flow.payees.slice(0, 10).map(party).join("\n")}` : "",
    audience === "staff" && waiting ? `DECLARED PAYMENTS STILL WAITING FOR THEIR BANK LINE: ${waiting}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
