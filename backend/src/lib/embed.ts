import { randomBytes } from "node:crypto";
import { anonymiseBankLine } from "./anonymise";
import { bankParty, buildFlow, type FlowLink, type FlowNode } from "./flow";
import { fundStats } from "./funds";
import { verifyChain } from "./ledger";
import { CATEGORIES, categoryLabel, type Category, type DB, type EmbedPublish, type EmbedTheme, type Fund, type LedgerEntry, type PublicEmbed, type Vendor } from "./types";

/**
 * Public embeds: a read-only widget for one fund that the NGO can put on any
 * website with an <iframe>.
 *
 * An admin chooses which blocks an embed publishes (`EmbedPublish`). The public
 * response is assembled here field by field from that choice. Nothing is copied
 * through from a ledger entry, a bank line or the audit log, so a field that
 * isn't named in this file can't reach the public:
 *
 *  - no staff names, approvers, reasons or audit-log entries
 *  - no donor or payer names, emails or bank descriptions
 *  - no bank account names, references, tracking codes or internal IDs
 *  - payees only if switched on, and by default only those registered under
 *    Settings → Payees (everyone else is grouped as "Other payees")
 *  - dates to the day, never the time
 */

// ------------------------------------------------------------- Settings ----

export const DEFAULT_PUBLISH: EmbedPublish = {
  totals: true,
  sources: true,
  categories: true,
  payees: "off",
  flow: false,
  timeline: false,
  activity: 0,
  integrity: true,
  funds: false,
};

/** The fundId of an embed that publishes every fund of the NGO together. Fund ids start with "fund_", so this can't clash. */
export const ALL_FUNDS = "all";

const ACTIVITY_SIZES = [0, 5, 10, 25] as const;
const PAYEE_MODES = ["off", "registered", "all"] as const;

/** Read an embed's settings from untrusted input. Unknown keys are dropped; anything unclear means "don't publish". */
export function cleanPublish(input: unknown): EmbedPublish {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const on = (k: string) => o[k] === true;
  return {
    totals: on("totals"),
    sources: on("sources"),
    categories: on("categories"),
    payees: PAYEE_MODES.find((m) => m === o.payees) ?? "off",
    flow: on("flow"),
    timeline: on("timeline"),
    activity: ACTIVITY_SIZES.find((n) => n === Number(o.activity)) ?? 0,
    integrity: on("integrity"),
    funds: on("funds"),
    donate: on("donate"),
  };
}

/** The blocks an embed publishes, in words (for the list of embeds and the audit log). */
export function publishedBlocks(p: EmbedPublish): string[] {
  return [
    p.totals && "totals",
    p.sources && "money in by channel",
    p.categories && "spending by category",
    p.payees === "registered" && "registered payees by name",
    p.payees === "all" && "every payee by name",
    p.flow && "money flow diagram",
    p.timeline && "money in and out over time",
    p.activity > 0 && `latest ${p.activity} movements`,
    p.integrity && "ledger integrity proof",
    p.funds && "each fund's totals",
    p.donate && "a donate form (PayPal)",
  ].filter((x): x is string => Boolean(x));
}

/** 128 random bits: the key is the only thing that makes an embed findable. */
export const newEmbedKey = () => randomBytes(16).toString("base64url");

const THEMES = ["light", "dark", "auto"] as const;
/** Read a theme from untrusted input; anything else is the default, light. */
export const cleanTheme = (raw: unknown): EmbedTheme => THEMES.find((t) => t === raw) ?? "light";
export const THEME_LABEL: Record<EmbedTheme, string> = { light: "light", dark: "dark", auto: "matches the visitor's device" };

/** The NGO's embeds. Data saved before embeds existed has no list yet. */
export function embedsOf(db: DB): PublicEmbed[] {
  return (db.embeds ??= []);
}

/** An embed as the admin screen shows it. */
export function embedView(db: DB, e: PublicEmbed) {
  const all = e.fundId === ALL_FUNDS;
  const funds = selectedFunds(db, e.ngoId, e);
  return {
    id: e.id,
    key: e.key,
    name: e.name,
    allFunds: all,
    theme: e.theme ?? "light",
    fundIds: all ? [] : funds.map((f) => f.id),
    fundTitle: all ? "All funds" : funds.map((f) => f.title).join(", ") || "Unknown fund",
    publish: e.publish,
    blocks: publishedBlocks(e.publish),
    enabled: e.enabled,
    createdAt: e.createdAt,
    createdByName: e.createdByName,
    updatedAt: e.updatedAt,
    updatedByName: e.updatedByName,
  };
}

// --------------------------------------------------------------- Payees ----

const OTHER_PAYEES = "Other payees";
const MAX_PAYEES = 10;

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

/**
 * The registered payee a ledger name refers to: the same name, or a bank line
 * that begins with the payee's first two words ("Medline Pharma clinic
 * restock" for "MedLine Pharma Distributors"). If more than one payee fits,
 * none is chosen: a wrong name in public is worse than a missing one.
 */
function registeredPayee(vendors: Vendor[], name: string) {
  const p = words(name);
  const exact = vendors.find((v) => words(v.name).join(" ") === p.join(" "));
  if (exact) return exact;
  const starts = vendors.filter((v) => {
    const w = words(v.name).slice(0, 2);
    return w.length > 0 && w.every((x, i) => p[i] === x);
  });
  return starts.length === 1 ? starts[0] : undefined;
}

/** How a payee may be named in public under the embed's setting, or null if it may not be. */
function payeeNamer(db: DB, ngoId: string, mode: EmbedPublish["payees"]) {
  const vendors = db.vendors.filter((v) => v.ngoId === ngoId);
  const knownOrganisations = vendors.map((v) => v.name);
  return (name: string): string | null => {
    if (mode === "off") return null;
    const registered = registeredPayee(vendors, name);
    if (registered) return registered.name;
    if (mode !== "all") return null;
    // Lines imported before statements were anonymised may still carry a person's name or an account number.
    const safe = anonymiseBankLine({ description: "", counterparty: name }, { scope: ngoId, knownOrganisations }).counterparty;
    return safe?.slice(0, 60) || null;
  };
}

// ------------------------------------------------------- Money in / out ----

type Channel = { id: string; label: string };

/** The public name of a source of money. Bank accounts are merged: their names are internal. */
function channelOf(nodeId: string): Channel {
  if (nodeId === "src:paypal") return { id: "paypal", label: "PayPal donations" };
  if (nodeId === "src:manual") return { id: "recorded", label: "Recorded by staff" };
  if (nodeId === "src:carry") return { id: "carry", label: "Carried in from other funds" };
  if (nodeId.startsWith("src:bank:")) return { id: "bank", label: "Bank transfers" };
  if (nodeId === "src:deficit") return { id: "deficit", label: "Overspent (out > in)" };
  return { id: "other", label: "Other" };
}

type Dest = { id: string; label: string; group: "spend" | "returned" | "held" };

/** The public name of where money went. Labels come from this list, never from the ledger. */
function destOf(nodeId: string): Dest {
  const cat = nodeId.startsWith("dst:cat:") ? CATEGORIES.find((c) => c.id === nodeId.slice(8)) : undefined;
  if (cat) return { id: `cat:${cat.id}`, label: cat.label, group: "spend" };
  if (nodeId === "dst:cat:none") return { id: "cat:none", label: "Uncategorised spend", group: "spend" };
  if (nodeId === "dst:fees") return { id: "fees", label: "Bank fees", group: "spend" };
  if (nodeId === "dst:refund") return { id: "refund", label: "Refunded to donors", group: "returned" };
  if (nodeId === "dst:carry") return { id: "carry", label: "Carried to other funds", group: "returned" };
  if (nodeId === "dst:balance") return { id: "balance", label: "Still held", group: "held" };
  return { id: "other", label: "Other", group: "spend" };
}

// ------------------------------------------------------------- Timeline ----

const DAY = 86400_000;
const MAX_POINTS = 180;

/** Cumulative money in (net of refunds and carry-outs) and out, one point per day. Mirrors the fund page's chart. */
function timeline(ledger: LedgerEntry[], startedAt: string) {
  const first = Math.min(Date.parse(startedAt), ...ledger.map((e) => Date.parse(e.ts)));
  const start = Date.parse(`${new Date(first).toISOString().slice(0, 10)}T00:00:00.000Z`);
  const end = Math.max(start + DAY, ...ledger.map((e) => Date.parse(e.ts)));
  const days = Math.max(1, Math.ceil((end - start + 1) / DAY));
  const sorted = [...ledger].sort((a, b) => a.ts.localeCompare(b.ts));
  const points: { date: string; in: number; out: number }[] = [];
  let moneyIn = 0;
  let moneyOut = 0;
  let i = 0;
  for (let d = 0; d < days; d++) {
    const dayEnd = start + (d + 1) * DAY;
    while (i < sorted.length && Date.parse(sorted[i].ts) < dayEnd) {
      const e = sorted[i++];
      if (e.type === "donation" || e.type === "carry_forward_in" || e.type === "bank_in") moneyIn += e.amount;
      if (e.type === "refund" || e.type === "refund_reversed" || e.type === "carry_forward_out") moneyIn += e.amount; // negative: money returned leaves the pot (a reversal brings it back)
      if (e.type === "withdrawal" || e.type === "bank_out" || e.type === "expense") moneyOut += -e.amount;
    }
    points.push({ date: new Date(start + d * DAY).toISOString().slice(0, 10), in: moneyIn, out: moneyOut });
  }
  // Long-running funds: keep every n-th day and always the latest.
  const step = Math.ceil(points.length / MAX_POINTS);
  return points.filter((_, idx) => idx % step === 0 || idx === points.length - 1);
}

// ------------------------------------------------------------- Activity ----

type Movement = { date: string; direction: "in" | "out"; label: string; detail?: string; payee?: string; amount: number; /** All-funds embeds: which fund. */ fund?: string };

/** The latest ledger entries that moved money, described without anything that identifies a person. */
function activity(db: DB, fund: Fund, ledger: LedgerEntry[], limit: number, nameOf: (name: string) => string | null): Movement[] {
  const out: Movement[] = [];
  // Bank lines are entered under their statement date, so the newest entry isn't always the last one written.
  const newestFirst = ledger.filter((e) => e.amount !== 0).sort((a, b) => b.ts.localeCompare(a.ts) || b.seq - a.seq);
  for (const e of newestFirst.slice(0, limit)) {
    const row: Movement = { date: e.ts.slice(0, 10), direction: e.amount > 0 ? "in" : "out", label: "Ledger entry", amount: Math.abs(e.amount) };
    if (e.type === "donation") row.label = e.paypalRef?.startsWith("MANUAL-") ? "Receipt recorded by staff" : "PayPal donation";
    else if (e.type === "carry_forward_in") row.label = "Carried in from another fund";
    else if (e.type === "carry_forward_out") row.label = "Carried to another fund";
    else if (e.type === "refund") row.label = e.memo.startsWith("Leftover returned") ? "Leftover returned to a donor" : "Refund to a donor";
    else if (e.type === "refund_reversed") row.label = "Return to a donor came back";
    else if (e.type === "withdrawal") {
      const w = db.withdrawals.find((x) => x.id === e.ref);
      const vendor = w && db.vendors.find((v) => v.id === w.vendorId);
      row.label = "Vendor payout";
      if (w) row.detail = categoryLabel(w.category);
      row.payee = (vendor && nameOf(vendor.name)) || undefined;
    } else if (e.type === "expense") {
      const p = db.payments?.find((x) => x.id === e.ref);
      if (e.amount > 0) row.label = "Correction: a recorded payment was voided";
      else {
        row.label = "Payment (receipt on file)";
        if (p?.category) row.detail = categoryLabel(p.category);
        row.payee = (p && nameOf(p.publicPayee)) || undefined;
      }
    } else if (e.type === "bank_in" || e.type === "bank_out") {
      const t = db.bankTxns.find((x) => x.id === e.ref);
      const reversal = (e.type === "bank_in") !== (e.amount > 0);
      if (reversal) row.label = "Correction: a bank line was moved to another fund";
      else if (e.type === "bank_in") row.label = "Bank transfer received";
      else if (t?.isFee) row.label = "Bank fee";
      else {
        row.label = "Bank payment";
        const category: Category | undefined = t?.allocations.find((a) => a.fundId === fund.id)?.category;
        if (category) row.detail = categoryLabel(category);
        row.payee = (t && nameOf(bankParty(t))) || undefined;
      }
    }
    out.push(row);
  }
  return out;
}

// -------------------------------------------------------------- Payload ----

export interface EmbedPayload {
  /** Present only when two or more funds are published together. */
  scope?: "combined";
  /** How the widget is coloured (set on public responses; previews pass it themselves). */
  theme?: EmbedTheme;
  fund: { title: string; region: string; status: Fund["status"]; accent: string };
  ngo: { name: string };
  /** When these numbers were read from the ledger. */
  asOf: string;
  totals?: { in: number; out: number; returned: number; held: number };
  sources?: { id: string; label: string; amount: number }[];
  categories?: { id: string; label: string; amount: number }[];
  payees?: { name: string; amount: number; payments: number; other?: boolean }[];
  flow?: { nodes: FlowNode[]; links: FlowLink[] };
  timeline?: { date: string; in: number; out: number }[];
  activity?: Movement[];
  integrity?: { valid: boolean; entries: number; head: string | null; ledgers?: number };
  /** Combined embeds: each fund's own totals, largest first. */
  funds?: { title: string; status: Fund["status"]; accent: string; in: number; out: number; held: number }[];
  /**
   * The donate form: the published funds still taking donations. Gifts go
   * through the fund's own donation link (its PayPal account and tracking code).
   */
  donate?: { funds: { slug: string; title: string; accent: string; code: string | null; returns: boolean }[] };
}

/**
 * Everything the public sees for one embed. Amounts are cents. Only the blocks
 * switched on in `publish` are present; the header (fund title, region, status
 * and the NGO's name) is always there and is already public on the fund's
 * donation link.
 */
export function buildEmbedPayload(db: DB, fund: Fund, publish: EmbedPublish, now = new Date()): EmbedPayload {
  const ngo = db.ngos.find((n) => n.id === fund.ngoId);
  const header = { fund: { title: fund.title, region: fund.region, status: fund.status, accent: fund.accent }, ngo: { name: ngo?.name ?? "" }, asOf: now.toISOString() };
  return assemble(db, fund.ngoId, [fund], header, { ...publish, funds: false });
}

/**
 * Several funds added together (every fund of the NGO, or the ones an admin
 * ticked). Fund names are public already on their donation links; nothing
 * else about a fund is added beyond the blocks switched on.
 */
export function buildCombinedPayload(db: DB, ngoId: string, funds: Fund[], publish: EmbedPublish, title: string, now = new Date()): EmbedPayload {
  const ngo = db.ngos.find((n) => n.id === ngoId);
  const header = {
    scope: "combined" as const,
    fund: { title, region: "", status: (funds.some((f) => f.status === "active") ? "active" : "closed") as Fund["status"], accent: "#0f766e" },
    ngo: { name: ngo?.name ?? "" },
    asOf: now.toISOString(),
  };
  return assemble(db, ngoId, funds, header, publish);
}

function assemble(db: DB, ngoId: string, funds: Fund[], header: Pick<EmbedPayload, "scope" | "fund" | "ngo" | "asOf">, publish: EmbedPublish): EmbedPayload {
  const many = header.scope === "combined";
  const out: EmbedPayload = { ...header };
  const ids = new Set(funds.map((f) => f.id));
  const ledgerOf = (f: Fund) => db.ledger.filter((l) => l.fundId === f.id);
  const ledger = db.ledger.filter((l) => ids.has(l.fundId));
  const stats = funds.map((f) => ({ f, s: fundStats(db, f) }));

  if (publish.totals) {
    out.totals = stats.reduce((a, { s }) => ({ in: a.in + s.raised, out: a.out + s.spent, returned: a.returned + s.refunded + s.carriedOut, held: a.held + s.balance }), { in: 0, out: 0, returned: 0, held: 0 });
  }

  const nameOf = payeeNamer(db, ngoId, publish.payees);

  if (publish.sources || publish.categories || publish.flow || publish.payees !== "off") {
    const graph = buildFlow(db, funds, { ngoId, includeUntraced: false });
    // Public node ids never carry internal fund ids: one fund is "fund"; several are "fund:0", "fund:1" and so on.
    const publicFund = new Map(funds.map((f, i) => [`fund:${f.id}`, many ? `fund:${i}` : "fund"]));
    const sources = new Map<string, Channel & { amount: number }>();
    const dests = new Map<string, Dest & { amount: number }>();
    const inLinks = new Map<string, number>();
    const outLinks = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
    for (const l of graph.category.links) {
      if (publicFund.has(l.target)) {
        const c = channelOf(l.source);
        sources.set(c.id, { ...c, amount: (sources.get(c.id)?.amount ?? 0) + l.value });
        bump(inLinks, `src:${c.id}|${publicFund.get(l.target)}`, l.value);
      } else if (publicFund.has(l.source)) {
        const d = destOf(l.target);
        dests.set(d.id, { ...d, amount: (dests.get(d.id)?.amount ?? 0) + l.value });
        bump(outLinks, `${publicFund.get(l.source)}|dst:${d.id}`, l.value);
      }
    }
    const byAmount = (a: { amount: number }, b: { amount: number }) => b.amount - a.amount;

    if (publish.sources) {
      out.sources = [...sources.values()].filter((s) => s.id !== "deficit").sort(byAmount).map(({ id, label, amount }) => ({ id, label, amount }));
    }
    if (publish.categories) {
      out.categories = [...dests.values()].filter((d) => d.group === "spend").sort(byAmount).map(({ id, label, amount }) => ({ id, label, amount }));
    }
    if (publish.flow) {
      const nodes: FlowNode[] = [
        ...[...sources.values()].map((s): FlowNode => ({ id: `src:${s.id}`, label: s.label, column: 0, kind: "source" })),
        ...funds.map((f): FlowNode => ({ id: publicFund.get(`fund:${f.id}`)!, label: f.title, column: 1, kind: "fund", color: f.accent })),
        ...[...dests.values()].map((d): FlowNode => ({ id: `dst:${d.id}`, label: d.label, column: 2, kind: "dest" })),
      ];
      const split = (k: string) => k.split("|") as [string, string];
      const links: FlowLink[] = [...inLinks, ...outLinks].map(([k, value]) => ({ source: split(k)[0], target: split(k)[1], value }));
      // A fund with no money yet would be a floating box.
      const used = new Set(links.flatMap((l) => [l.source, l.target]));
      out.flow = { nodes: nodes.filter((n) => used.has(n.id) || (!many && n.kind === "fund")), links };
    }
    if (publish.payees !== "off") {
      const named = new Map<string, { name: string; amount: number; payments: number }>();
      const other = { name: OTHER_PAYEES, amount: 0, payments: 0, other: true };
      const add = (to: { amount: number; payments: number }, p: { total: number; count: number }) => {
        to.amount += p.total;
        to.payments += p.count;
      };
      for (const p of graph.payees) {
        const name = nameOf(p.name);
        if (!name) add(other, p);
        else add(named.get(name) ?? named.set(name, { name, amount: 0, payments: 0 }).get(name)!, p);
      }
      const ranked = [...named.values()].sort(byAmount);
      for (const p of ranked.slice(MAX_PAYEES)) add(other, { total: p.amount, count: p.payments });
      out.payees = [...ranked.slice(0, MAX_PAYEES), ...(other.amount > 0 ? [other] : [])];
    }
  }

  if (publish.timeline) {
    const start = funds.reduce((a, f) => (f.startedAt < a ? f.startedAt : a), funds[0]?.startedAt ?? new Date().toISOString());
    out.timeline = timeline(ledger, start);
  }
  if (publish.activity > 0) {
    out.activity = funds
      .flatMap((f) => activity(db, f, ledgerOf(f), publish.activity, nameOf).map((m) => (many ? { ...m, fund: f.title } : m)))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, publish.activity);
  }
  if (publish.integrity) {
    const chains = funds.map((f) => {
      const l = ledgerOf(f);
      return { entries: l.length, c: verifyChain(l) };
    });
    const valid = chains.every((x) => x.c.valid);
    out.integrity = many
      ? { valid, entries: ledger.length, head: null, ledgers: funds.length }
      : { valid, entries: chains[0]?.entries ?? 0, head: (valid && chains[0]?.c.head) || null };
  }
  if (many && publish.funds) {
    out.funds = stats.map(({ f, s }) => ({ title: f.title, status: f.status, accent: f.accent, in: s.raised, out: s.spent, held: s.balance })).sort((a, b) => b.in - a.in);
  }
  if (publish.donate) {
    out.donate = {
      funds: funds
        .filter((f) => f.status === "active")
        .map((f) => ({ slug: f.slug, title: f.title, accent: f.accent, code: f.trackingCodes?.[0] ?? null, returns: Boolean(f.donorReturns) })),
    };
  }
  return out;
}

/** Every fund of the NGO, for an "all funds" embed. */
export const allFundsOf = (db: DB, ngoId: string) => db.funds.filter((f) => f.ngoId === ngoId);

/**
 * The funds an embed (or a draft of one) publishes, in the NGO's order. Funds
 * of another NGO and deleted funds are dropped, never published.
 */
export function selectedFunds(db: DB, ngoId: string, sel: { fundId: string; fundIds?: string[] }) {
  if (sel.fundId === ALL_FUNDS) return allFundsOf(db, ngoId);
  const want = new Set(sel.fundIds?.length ? sel.fundIds : [sel.fundId]);
  return db.funds.filter((f) => f.ngoId === ngoId && want.has(f.id));
}

/** The public response for a selection: one fund as before, two or more added together. */
export function payloadFor(db: DB, ngoId: string, sel: { fundId: string; fundIds?: string[] }, publish: EmbedPublish) {
  const funds = selectedFunds(db, ngoId, sel);
  if (!funds.length) return null;
  if (sel.fundId !== ALL_FUNDS && funds.length === 1) return buildEmbedPayload(db, funds[0], publish);
  return buildCombinedPayload(db, ngoId, funds, publish, sel.fundId === ALL_FUNDS ? "All our relief funds" : "Our relief funds");
}

/** The payload behind a public key, or null if there is no live embed with that key. */
export function publicEmbedPayload(db: DB, key: string) {
  const embed = embedsOf(db).find((e) => e.key === key);
  if (!embed || !embed.enabled) return null;
  const payload = payloadFor(db, embed.ngoId, embed, embed.publish);
  return payload ? { embed, payload: { ...payload, theme: embed.theme ?? "light" } } : null;
}
