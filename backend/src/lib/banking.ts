import { createHash } from "node:crypto";
import { audit } from "./audit";
import { newId, nowIso } from "./db";
import { appendLedger } from "./ledger";
import { fmt } from "./money";
import type { AuditEntry, BankAccount, BankAllocation, BankReceipt, BankTxn, Category, DB, Fund, LedgerEntry, NgoControls, PendingTag, StatementImport } from "./types";
import { CATEGORIES } from "./types";

/**
 * Bank statements and tracking codes.
 *
 * Every bank line (from a CSV upload or a Plaid sync) is read for a tracking
 * code such as "#RO1" or "#ASHA-MED". A fund can have several codes. A line
 * whose code belongs to exactly one fund is tagged to it automatically; a line
 * with no code, an unknown code, or codes for more than one fund waits in the
 * Untagged queue until a person tags (or splits) it with a reason.
 *
 * Tagging is rule-based only: no AI ever guesses a code. Tagged money is
 * posted to the fund's hash-chained ledger (bank_in / bank_out). A retag never
 * edits history: it posts reversing entries, then the new allocation.
 */

// ---------------------------------------------------------------- Codes ----

/** "RO1", "ASHA", "FL24": a letter, then 1–11 letters or digits. */
export const CODE_RE = /^[A-Z][A-Z0-9]{1,11}$/;

/** "#RO1", "#ro1-med", "#ASHA-LOG" anywhere in a description. */
const FIND_RE = /#([A-Za-z][A-Za-z0-9]{1,11})(?:-([A-Za-z]{2,8}))?(?![A-Za-z0-9])/g;

/** Optional sub-code after the dash: the budget category inside the fund. */
export const SUBCODES: Record<string, Category> = {
  FOOD: "food",
  WAT: "water",
  WATER: "water",
  WASH: "water",
  SHL: "shelter",
  SHELTER: "shelter",
  MED: "medical",
  MEDICAL: "medical",
  HYG: "hygiene",
  LOG: "logistics",
  CASH: "cash_aid",
  ADM: "admin",
  ADMIN: "admin",
  OPS: "admin",
};

export function normaliseCode(raw: string) {
  return raw.trim().replace(/^#/, "").toUpperCase();
}

/** Code → fund, for every fund of the NGO. */
export function codeIndex(db: DB, ngoId: string) {
  const idx = new Map<string, Fund>();
  for (const f of db.funds) if (f.ngoId === ngoId) for (const c of f.trackingCodes ?? []) idx.set(c, f);
  return idx;
}

export type CodeMatch =
  | { kind: "tagged"; fund: Fund; code: string; category?: Category }
  | { kind: "untagged"; reason: string };

/** Read the tracking code(s) in a description. Exact matches only; nothing is guessed. */
export function matchCodes(description: string, idx: Map<string, Fund>): CodeMatch & { found: string[] } {
  const found: { code: string; sub?: string }[] = [];
  for (const m of description.matchAll(FIND_RE)) found.push({ code: m[1].toUpperCase(), sub: m[2]?.toUpperCase() });
  const labels = found.map((f) => `#${f.code}${f.sub ? `-${f.sub}` : ""}`);
  const known = found.filter((f) => idx.has(f.code));
  if (!known.length) {
    return { kind: "untagged", reason: found.length ? `Unknown code ${labels.join(", ")}` : "No tracking code in the description", found: labels };
  }
  const funds = new Set(known.map((k) => idx.get(k.code)!.id));
  if (funds.size > 1) return { kind: "untagged", reason: `Codes for more than one fund (${labels.join(", ")}): split it by hand`, found: labels };
  const fund = idx.get(known[0].code)!;
  if (fund.status === "closed") return { kind: "untagged", reason: `#${known[0].code} belongs to ${fund.title}, which is closed`, found: labels };
  const withSub = known.find((k) => k.sub && SUBCODES[k.sub]);
  const first = withSub ?? known[0];
  return { kind: "tagged", fund, code: `${first.code}${first.sub ? `-${first.sub}` : ""}`, category: first.sub ? SUBCODES[first.sub] : undefined, found: labels };
}

// ----------------------------------------------------------------- Fees ----

/** Bank / aggregator type codes that mean "this is a charge" (OFX, MT940, Plaid). */
const FEE_TYPE_CODES = new Set(["SRVCHG", "FEE", "NCHG", "NCOM", "BANK_FEES", "CHARGE", "CHG"]);

export function looksLikeFee(account: BankAccount, description: string, typeCode?: string) {
  if (typeCode && FEE_TYPE_CODES.has(typeCode.trim().toUpperCase())) return true;
  const d = description.toUpperCase();
  return account.feePatterns.some((p) => p.trim() && d.includes(p.trim().toUpperCase()));
}

// ------------------------------------------------------------- Controls ----

export const DEFAULT_CONTROLS: NgoControls = {
  tagApprovalThreshold: 100_000,
  receiptThreshold: 100_000,
  feePolicy: { mode: "unallocated" },
};

/** The NGO's tracking controls, with defaults for anything not set yet. */
export function controlsOf(db: DB, ngoId: string): NgoControls {
  const c = db.ngos.find((n) => n.id === ngoId)?.controls;
  return { ...DEFAULT_CONTROLS, ...c, feePolicy: { ...DEFAULT_CONTROLS.feePolicy, ...c?.feePolicy } };
}

/** The fund a fee should be charged to under the NGO's fee policy, if any. */
function feePolicyTarget(db: DB, ngoId: string) {
  const p = controlsOf(db, ngoId).feePolicy;
  if (p.mode !== "fund" || !p.fundId) return null;
  const fund = db.funds.find((f) => f.id === p.fundId && f.ngoId === ngoId && f.status !== "closed");
  return fund ? { fund, category: p.category ?? ("admin" as Category) } : null;
}

/** Does this bank payment need a receipt (by the NGO's threshold) and still lack one? */
export function missingReceipt(db: DB, t: BankTxn, ngoId: string) {
  return t.amount < 0 && !t.isFee && t.allocations.length > 0 && Math.abs(t.amount) >= controlsOf(db, ngoId).receiptThreshold && !(t.receipts?.length);
}

// -------------------------------------------------------------- Ingest ----

export type ParsedRow = { date: string; amount: number; description: string; counterparty?: string; reference?: string; typeCode?: string };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Stable de-duplication key. Provider IDs win; otherwise date + amount +
 * description, plus how many identical lines came before it in the same batch
 * (two genuine $50 gifts on one day stay two rows, but re-uploading an
 * overlapping statement adds nothing).
 */
export function dedupeKeys(accountId: string, rows: ParsedRow[]) {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    if (r.reference) return `ext:${accountId}:${r.reference}`;
    const base = `${r.date}|${r.amount}|${norm(r.description)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `row:${accountId}:${createHash("sha256").update(base).digest("hex").slice(0, 24)}:${n}`;
  });
}

const ledgerTs = (date: string) => (/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00.000Z` : date);

export function postAllocations(db: DB, account: BankAccount, t: BankTxn, allocations: BankAllocation[], note: string, ts?: string) {
  const entries: LedgerEntry[] = [];
  const type = t.amount >= 0 ? "bank_in" : "bank_out";
  const sign = t.amount >= 0 ? 1 : -1;
  for (const a of allocations) {
    entries.push(
      appendLedger(db, {
        fundId: a.fundId,
        type,
        amount: sign * a.amount,
        memo: `${t.description} · ${account.name}${a.code ? ` · #${a.code}` : ""}${a.category ? ` · ${CATEGORIES.find((c) => c.id === a.category)?.label}` : ""}${note ? ` · ${note}` : ""}`.slice(0, 300),
        actor: t.counterparty || account.institution,
        ref: t.id,
        paypalRef: t.externalId ? `BANK-${t.externalId}`.slice(0, 60) : undefined,
        ts,
      }),
    );
  }
  return entries;
}

function reverseAllocations(db: DB, account: BankAccount, t: BankTxn, reason: string) {
  const entries: LedgerEntry[] = [];
  const type = t.amount >= 0 ? "bank_in" : "bank_out";
  const sign = t.amount >= 0 ? -1 : 1;
  for (const a of t.allocations) {
    entries.push(
      appendLedger(db, {
        fundId: a.fundId,
        type,
        amount: sign * a.amount,
        memo: `Reversal (retagged): ${t.description} · ${reason}`.slice(0, 300),
        actor: t.counterparty || account.institution,
        ref: t.id,
      }),
    );
  }
  return entries;
}

/**
 * Classify one bank line and post it to a fund ledger if a code matched. A
 * code in the description always wins; a fee with no code follows the NGO's
 * fee policy when `applyFeePolicy` is set (new imports, or an explicit re-apply).
 */
function classify(db: DB, account: BankAccount, t: BankTxn, idx: Map<string, Fund>, ledgerAt: string | undefined, applyFeePolicy: boolean) {
  const m = matchCodes(t.description, idx);
  if (m.kind === "tagged") {
    t.status = "auto_tagged";
    t.tagSource = "code";
    t.allocations = [{ fundId: m.fund.id, amount: Math.abs(t.amount), code: m.code, category: m.category }];
    t.untaggedReason = undefined;
    t.taggedAt = nowIso();
    return postAllocations(db, account, t, t.allocations, "", ledgerAt ?? ledgerTs(t.date));
  }
  const target = t.isFee && applyFeePolicy ? feePolicyTarget(db, account.ngoId) : null;
  if (target) {
    const c = controlsOf(db, account.ngoId);
    t.status = "auto_tagged";
    t.tagSource = "fee_policy";
    t.allocations = [{ fundId: target.fund.id, amount: Math.abs(t.amount), code: target.fund.trackingCodes?.[0], category: target.category }];
    t.untaggedReason = undefined;
    t.taggedAt = nowIso();
    t.reason = `Fee policy${c.updatedBy ? ` set by ${c.updatedBy}` : ""}: bank fees are charged to ${target.fund.title}`;
    return postAllocations(db, account, t, t.allocations, "fee policy", ledgerAt ?? ledgerTs(t.date));
  }
  t.status = t.isFee ? "fee_unallocated" : "untagged";
  t.untaggedReason = t.isFee ? "Bank fee: left unallocated (general fund) by policy" : m.reason;
  return [];
}

/**
 * Add parsed rows to an account. Rows already imported are skipped, the rest
 * are matched against tracking codes. Call inside `mutate`.
 */
export function ingestRows(
  db: DB,
  account: BankAccount,
  rows: ParsedRow[],
  meta: { source: StatementImport["source"]; fileName?: string; fileSha256?: string; actor: { id: string; name: string }; errors?: string[]; at?: string },
) {
  const keys = dedupeKeys(account.id, rows);
  const existing = new Set(db.bankTxns.filter((t) => t.accountId === account.id).map((t) => t.dedupeKey));
  const idx = codeIndex(db, account.ngoId);
  const imp: StatementImport = {
    id: newId("imp"),
    accountId: account.id,
    source: meta.source,
    fileName: meta.fileName,
    fileSha256: meta.fileSha256,
    rows: rows.length,
    imported: 0,
    duplicates: 0,
    autoTagged: 0,
    errors: meta.errors ?? [],
    createdAt: meta.at ?? nowIso(),
    createdBy: meta.actor.id,
  };
  const entries: LedgerEntry[] = [];
  rows.forEach((r, i) => {
    if (existing.has(keys[i])) {
      imp.duplicates += 1;
      return;
    }
    existing.add(keys[i]);
    const t: BankTxn = {
      id: newId("btx"),
      accountId: account.id,
      importId: imp.id,
      externalId: r.reference,
      dedupeKey: keys[i],
      date: r.date,
      amount: r.amount,
      description: r.description.slice(0, 300),
      counterparty: r.counterparty?.slice(0, 120),
      typeCode: r.typeCode,
      isFee: r.amount < 0 && looksLikeFee(account, r.description, r.typeCode),
      status: "untagged",
      allocations: [],
      history: [],
      createdAt: meta.at ?? nowIso(),
    };
    entries.push(...classify(db, account, t, idx, undefined, true));
    if (t.status === "auto_tagged") imp.autoTagged += 1;
    imp.imported += 1;
    db.bankTxns.push(t);
  });
  db.statementImports.push(imp);
  account.lastSyncAt = meta.at ?? nowIso();
  return { imp, entries };
}

/**
 * After a fund's codes change, look again at everything still untagged (or
 * unallocated fees). Lines that now match exactly one fund are tagged. With
 * `feesOnly`, only unallocated fees are looked at and the fee policy is applied.
 */
export function rescanUntagged(db: DB, ngoId: string, opts: { feesOnly?: boolean } = {}) {
  const idx = codeIndex(db, ngoId);
  const entries: LedgerEntry[] = [];
  let tagged = 0;
  for (const t of db.bankTxns) {
    if (opts.feesOnly ? t.status !== "fee_unallocated" : t.status !== "untagged" && t.status !== "fee_unallocated") continue;
    if (t.pending) continue;
    const account = db.bankAccounts.find((a) => a.id === t.accountId);
    if (!account || account.ngoId !== ngoId) continue;
    const got = classify(db, account, t, idx, nowIso(), Boolean(opts.feesOnly));
    if ((t.status as BankTxn["status"]) === "auto_tagged") {
      tagged += 1;
      entries.push(...got);
    }
  }
  return { tagged, entries };
}

// -------------------------------------------------------- Manual tagging ----

export type AllocationInput = { fundId: string; amount: number; category?: string };

/**
 * Tag, split, retag or untag a bank line by hand. `allocations` must add up
 * to the full amount (or be empty to send it back to the Untagged queue).
 * Call inside `mutate`. Permission checks happen in the route.
 */
function checkAllocations(db: DB, t: BankTxn, input: AllocationInput[], reason: string) {
  const account = db.bankAccounts.find((a) => a.id === t.accountId)!;
  const total = Math.abs(t.amount);
  const allocations: BankAllocation[] = input.map((a) => {
    const fund = db.funds.find((f) => f.id === a.fundId && f.ngoId === account.ngoId);
    if (!fund) throw new Error("Choose a fund for every row");
    if (fund.status === "closed") throw new Error(`${fund.title} is closed`);
    const amount = Math.round(a.amount);
    if (!(amount > 0)) throw new Error("Every split needs an amount above zero");
    const category = a.category ? (CATEGORIES.find((c) => c.id === a.category)?.id ?? undefined) : undefined;
    return { fundId: fund.id, amount, category, code: fund.trackingCodes?.[0] };
  });
  // Merge duplicate (fund, category) rows.
  const merged: BankAllocation[] = [];
  for (const a of allocations) {
    const same = merged.find((m) => m.fundId === a.fundId && m.category === a.category);
    if (same) same.amount += a.amount;
    else merged.push({ ...a });
  }
  const sum = merged.reduce((s, a) => s + a.amount, 0);
  if (merged.length && sum !== total) throw new Error(`Splits add up to ${fmt(sum)}, but the transaction is ${fmt(total)}`);
  if (!reason.trim()) throw new Error("Give a reason for the tag");
  return { account, total, merged };
}

const describeAllocs = (db: DB, as: BankAllocation[]) =>
  as.length ? as.map((a) => `${fmt(a.amount)} → ${db.funds.find((f) => f.id === a.fundId)?.title ?? a.fundId}`).join(", ") : "untagged";

/**
 * Does this manual change need a second person? Retags and untags always do
 * (they change money already on a ledger); a first tag does at or above the
 * NGO's approval threshold.
 */
export function approvalNeeded(db: DB, t: BankTxn, ngoId: string): string | null {
  if (t.allocations.length) return "Changes to a line that's already tagged need a second person";
  const threshold = controlsOf(db, ngoId).tagApprovalThreshold;
  if (Math.abs(t.amount) >= threshold) return `Tags of ${fmt(threshold)} or more need a second person`;
  return null;
}

/** Record a manual tag as waiting for approval. Nothing is posted to a ledger yet. */
export function requestTag(db: DB, t: BankTxn, input: AllocationInput[], reason: string, actor: { id: string; name: string }, why: string) {
  if (t.pending) throw new Error(`${t.pending.byName} already has a change waiting for approval on this line`);
  const { account, total, merged } = checkAllocations(db, t, input, reason);
  const kind: PendingTag["kind"] = !merged.length ? "untag" : t.allocations.length ? "retag" : "tag";
  t.pending = { kind, allocations: merged, reason: reason.trim().slice(0, 300), byId: actor.id, byName: actor.name, at: nowIso(), why };
  const dir = t.amount >= 0 ? "in" : "out";
  return audit(db, {
    actor,
    action: "bank.tag_requested",
    fundId: merged[0]?.fundId ?? t.allocations[0]?.fundId,
    targetId: t.id,
    summary: `Asked for approval to ${kind} bank ${dir === "in" ? "receipt" : "payment"} ${fmt(total)} "${t.description.slice(0, 80)}": ${t.allocations.length ? `${describeAllocs(db, t.allocations)} ⇒ ` : ""}${describeAllocs(db, merged)}. Reason: ${t.pending.reason}`,
    meta: { amount: total, direction: dir, splits: merged.length, account: account.name },
  });
}

/** Turn down (or, by its maker, withdraw) a pending change. */
export function rejectTag(db: DB, t: BankTxn, actor: { id: string; name: string }, note: string) {
  const p = t.pending;
  if (!p) throw new Error("Nothing is waiting for approval on this line");
  t.pending = undefined;
  const own = actor.id === p.byId;
  return audit(db, {
    actor,
    action: "bank.tag_rejected",
    fundId: p.allocations[0]?.fundId ?? t.allocations[0]?.fundId,
    targetId: t.id,
    summary: `${own ? "Withdrew" : `Turned down ${p.byName}'s`} request to ${p.kind} ${fmt(Math.abs(t.amount))} "${t.description.slice(0, 80)}" (${describeAllocs(db, p.allocations)})${note ? `. Note: ${note}` : ""}`,
    meta: { amount: Math.abs(t.amount), kind: p.kind },
  });
}

/**
 * Apply a manual tag, split, retag or untag. Without `approval` the actor's
 * change takes effect at once (below the threshold); with it, the pending
 * change made by `actor` is applied on the approver's sign-off.
 */
export function tagManually(db: DB, t: BankTxn, input: AllocationInput[], reason: string, actor: { id: string; name: string }, approval?: { by: { id: string; name: string } }) {
  const { account, total, merged } = checkAllocations(db, t, input, reason);
  const before = t.allocations;
  const wasTagged = before.length > 0;
  const entries: LedgerEntry[] = [];
  const approvedNote = approval ? `, approved by ${approval.by.name}` : "";
  if (wasTagged) {
    t.history.push({ allocations: before, by: t.taggedByName ?? (t.tagSource === "code" ? "Tracking code" : t.tagSource === "fee_policy" ? "Fee policy" : "unknown"), at: t.taggedAt ?? t.createdAt, reason: t.reason, approvedBy: t.approvedByName });
    entries.push(...reverseAllocations(db, account, t, `${reason.trim()}${approvedNote}`));
  }
  t.allocations = merged;
  t.reason = reason.trim().slice(0, 300);
  t.taggedBy = actor.id;
  t.taggedByName = actor.name;
  t.taggedAt = nowIso();
  t.approvedByName = approval?.by.name;
  t.approvedAt = approval ? nowIso() : undefined;
  t.pending = undefined;
  if (merged.length) {
    t.status = "tagged";
    t.tagSource = "manual";
    t.untaggedReason = undefined;
    entries.push(...postAllocations(db, account, t, merged, `tagged by ${actor.name}${approvedNote}: ${t.reason}`, nowIso()));
  } else {
    t.status = t.isFee ? "fee_unallocated" : "untagged";
    t.tagSource = undefined;
    t.untaggedReason = `Untagged by ${actor.name}${approvedNote}: ${t.reason}`;
  }

  const dir = t.amount >= 0 ? "in" : "out";
  const what = `bank ${dir === "in" ? "receipt" : "payment"} ${fmt(total)} "${t.description.slice(0, 80)}": ${wasTagged ? `${describeAllocs(db, before)} ⇒ ` : ""}${describeAllocs(db, merged)}. Reason: ${t.reason}`;
  const entry: AuditEntry = audit(db, {
    actor: approval?.by ?? actor,
    action: approval ? "bank.tag_approved" : wasTagged ? "bank.retagged" : "bank.tagged",
    fundId: merged[0]?.fundId ?? before[0]?.fundId,
    targetId: t.id,
    summary: approval ? `Approved ${actor.name}'s ${wasTagged ? "retag" : "tag"} of ${what}` : `${wasTagged ? "Retagged" : "Tagged"} ${what}`,
    meta: { amount: total, direction: dir, splits: merged.length, account: account.name, ...(approval ? { maker: actor.name } : {}) },
  });
  return { entries, audit: entry };
}

/** May this member sign off someone else's pending change? Not the maker; an admin, or someone assigned to every fund involved. */
export function canApprove(db: DB, t: BankTxn, member: { id: string; role: string }) {
  const p = t.pending;
  if (!p || p.byId === member.id) return false;
  if (member.role === "admin") return true;
  const ids = new Set([...p.allocations, ...t.allocations].map((a) => a.fundId));
  return [...ids].every((id) => {
    const f = db.funds.find((x) => x.id === id);
    return Boolean(f && canTagTo(f, member));
  });
}

// ------------------------------------------------------------ Receipts ----

const simplify = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\b(PVT|LTD|LLC|INC|CO|CORP|LIMITED|THE|AND)\b/g, " ").replace(/\s+/g, " ").trim();

/** Fixed scoring rule (no AI): how well a scanned receipt matches the bank line it's attached to. */
export function scoreReceipt(t: BankTxn, x: NonNullable<BankReceipt["extraction"]>): BankReceipt["match"] {
  const signals: string[] = [];
  let score = 0;
  const amount = Math.abs(t.amount);
  if (x.total != null && (!x.currency || x.currency.toUpperCase() === "USD")) {
    const cents = Math.round(x.total * 100);
    if (cents === amount) {
      score += 50;
      signals.push("Amount matches exactly");
    } else if (Math.abs(cents - amount) <= amount * 0.01) {
      score += 45;
      signals.push("Amount within 1%");
    } else signals.push(`Amount differs: receipt ${fmt(cents)}, bank ${fmt(amount)}`);
  } else signals.push(x.total == null ? "No total read from the receipt" : `Receipt is in ${x.currency}; amount not compared`);
  if (x.date && /^\d{4}-\d{2}-\d{2}$/.test(x.date)) {
    const days = Math.round((Date.parse(`${t.date}T00:00:00Z`) - Date.parse(`${x.date}T00:00:00Z`)) / 86400_000);
    if (days >= 0 && days <= 7) {
      score += 25;
      signals.push(`Paid ${days} day${days === 1 ? "" : "s"} after the receipt date`);
    } else if (days >= 0 && days <= 30) {
      score += 10;
      signals.push(`Paid ${days} days after the receipt date`);
    } else signals.push(days < 0 ? "Paid before the receipt date" : `Paid ${days} days after the receipt date`);
  }
  if (x.supplier) {
    const a = simplify(x.supplier);
    const b = simplify(`${t.counterparty ?? ""} ${t.description}`);
    const words = a.split(" ").filter((w) => w.length > 2);
    const hit = words.filter((w) => b.includes(w)).length;
    if (words.length && hit / words.length >= 0.5) {
      score += 20;
      signals.push("Supplier name appears on the bank line");
    } else signals.push(`Supplier "${x.supplier}" not found on the bank line`);
  }
  if (x.invoiceNumber && t.description.toUpperCase().includes(x.invoiceNumber.toUpperCase())) {
    score += 5;
    signals.push("Invoice number appears in the bank description");
  }
  return { score, signals };
}

// ------------------------------------------------------------ Visibility ----

/** Admins see every bank line; staff see the untagged queue plus lines on funds they're assigned to. */
export function canSeeTxn(t: BankTxn, member: { id: string; role: string }, db: DB) {
  if (member.role === "admin") return true;
  if (t.status === "untagged" || t.status === "fee_unallocated") return true;
  return t.allocations.some((a) => db.funds.find((f) => f.id === a.fundId)?.assignees.includes(member.id));
}

/** Staff may tag to (and retag away from) only the funds they're assigned to. */
export function canTagTo(fund: Fund, member: { id: string; role: string }) {
  return member.role === "admin" || fund.assignees.includes(member.id);
}

export function txnView(db: DB, t: BankTxn, me?: { id: string; role: string }) {
  const account = db.bankAccounts.find((a) => a.id === t.accountId);
  const fundTitle = (id: string) => db.funds.find((f) => f.id === id)?.title ?? id;
  return {
    id: t.id,
    accountId: t.accountId,
    accountName: account?.name ?? "",
    provider: account?.provider ?? "csv",
    date: t.date,
    amount: t.amount,
    description: t.description,
    counterparty: t.counterparty,
    reference: t.externalId,
    typeCode: t.typeCode,
    isFee: t.isFee,
    status: t.status,
    untaggedReason: t.untaggedReason,
    allocations: t.allocations.map((a) => ({ ...a, fundTitle: fundTitle(a.fundId) })),
    tagSource: t.tagSource,
    taggedByName: t.taggedByName,
    taggedAt: t.taggedAt,
    reason: t.reason,
    approvedByName: t.approvedByName,
    pending: t.pending && {
      ...t.pending,
      allocations: t.pending.allocations.map((a) => ({ ...a, fundTitle: fundTitle(a.fundId) })),
      mine: me?.id === t.pending.byId,
      canApprove: me ? canApprove(db, t, me) : false,
    },
    receipts: (t.receipts ?? []).map((r) => ({ ...r, fileName: db.files.find((f) => f.id === r.fileId)?.name ?? "receipt", url: `/api/files/${r.fileId}` })),
    missingReceipt: account ? missingReceipt(db, t, account.ngoId) : false,
    history: t.history,
    ageDays: Math.floor((Date.now() - Date.parse(t.createdAt)) / 86400_000),
  };
}
