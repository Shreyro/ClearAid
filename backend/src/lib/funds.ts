import { createHash } from "node:crypto";
import { getDb, mutate, newId, nowIso, withLock } from "./db";
import { appendLedger, verifyChain } from "./ledger";
import { audit, SYSTEM_ACTOR } from "./audit";
import { fmt, splitProRata } from "./money";
import { publish } from "./events";
import { sendVendorPayout } from "./paypal";
import { fundConn } from "./paypal-accounts";
import type { Category, DB, Donation, Donor, Fund, LedgerEntry, Withdrawal } from "./types";
import { categoryLabel } from "./types";

// ------------------------------------------------------------- Lookups ----

export const findFund = (db: DB, idOrSlug: string) => db.funds.find((f) => f.id === idOrSlug || f.slug === idOrSlug);

export function donorLabel(donor: Donor | undefined) {
  if (!donor) return "Anonymous donor";
  if (donor.publicName) return donor.publicName;
  const tag = createHash("sha256").update(donor.id).digest("hex").slice(0, 4).toUpperCase();
  return `Anonymous donor #${tag}`;
}

export const donationAvailable = (d: Donation) => d.amount - d.attributed - d.refunded - d.carriedOut;

const fundLedger = (db: DB, fundId: string) => db.ledger.filter((l) => l.fundId === fundId);

// --------------------------------------------------------------- Stats ----

export function fundStats(db: DB, fund: Fund) {
  const ledger = fundLedger(db, fund.id);
  const sum = (t: LedgerEntry["type"][]) =>
    ledger.filter((l) => t.includes(l.type)).reduce((a, l) => a + Math.abs(l.amount), 0);
  // Bank lines are signed: a retag posts a reversing entry, so sum them as-is.
  const signed = (t: LedgerEntry["type"]) => ledger.filter((l) => l.type === t).reduce((a, l) => a + l.amount, 0);
  const bankIn = signed("bank_in");
  const bankOut = -signed("bank_out");
  const raised = sum(["donation", "carry_forward_in"]) + bankIn;
  // Declared payments are signed too: voiding one posts the money back.
  const declaredOut = -signed("expense");
  const spent = sum(["withdrawal"]) + bankOut + declaredOut;
  const refunded = sum(["refund"]);
  const carriedOut = sum(["carry_forward_out"]);
  const balance = raised - spent - refunded - carriedOut;

  const donations = db.donations.filter((d) => d.fundId === fund.id);
  const donors = new Set(donations.map((d) => d.donorId)).size;
  const ws = db.withdrawals.filter((w) => w.fundId === fund.id);
  const paid = ws.filter((w) => w.status === "paid");

  const byCategory: Partial<Record<Category, number>> = {};
  for (const w of paid) byCategory[w.category] = (byCategory[w.category] ?? 0) + w.amount;
  for (const t of db.bankTxns ?? []) {
    if (t.amount >= 0) continue;
    for (const a of t.allocations) if (a.fundId === fund.id && a.category) byCategory[a.category] = (byCategory[a.category] ?? 0) + a.amount;
  }

  const verifiedSpend = paid
    .filter((w) => w.audit && w.audit.verdict === "approve" && w.audit.riskScore <= 30)
    .reduce((a, w) => a + w.amount, 0);
  const proofSpend = paid.filter((w) => w.photoFileIds.length > 0).reduce((a, w) => a + w.amount, 0);
  const adminSpend = byCategory.admin ?? 0;
  const adminCap = fund.policy.categoryCaps.admin ?? 10;

  const weekAgo = Date.now() - 7 * 86400_000;
  const spent7d = paid.filter((w) => w.paidAt && Date.parse(w.paidAt) >= weekAgo).reduce((a, w) => a + w.amount, 0);
  const dailyBurn = spent7d / 7;
  const runwayDays = dailyBurn > 0 ? Math.round(balance / dailyBurn) : null;

  const chain = verifyChain(ledger);
  const verifiedPct = spent ? verifiedSpend / spent : 1;
  const proofPct = spent ? proofSpend / spent : 1;
  const adminPct = spent ? (adminSpend / spent) * 100 : 0;
  const stale = ws.filter((w) => w.status === "pending_approval" && Date.now() - Date.parse(w.createdAt) > 48 * 3600_000).length;

  const score = {
    verified: Math.round(35 * verifiedPct),
    proof: Math.round(20 * proofPct),
    overhead: adminPct <= adminCap ? 15 : Math.max(0, Math.round(15 - (adminPct - adminCap))),
    integrity: chain.valid ? 15 : 0,
    responsiveness: Math.max(0, 15 - stale * 5),
  };
  const transparency = Object.values(score).reduce((a, b) => a + b, 0);

  return {
    raised,
    spent,
    refunded,
    carriedOut,
    balance,
    bankIn,
    bankOut,
    donors,
    donationCount: donations.filter((d) => d.source === "paypal").length,
    byCategory,
    pending: ws.filter((w) => w.status === "pending_approval" || w.status === "auditing").length,
    flagged: ws.filter((w) => w.status === "rejected").length,
    paidCount: paid.length,
    verifiedPct,
    proofPct,
    adminPct,
    dailyBurn: Math.round(dailyBurn),
    runwayDays,
    chainValid: chain.valid,
    chainHead: chain.valid ? chain.head : null,
    transparency,
    transparencyBreakdown: score,
    beneficiaries: paid.reduce((a, w) => a + (w.beneficiaries ?? 0), 0),
  };
}

export type FundStats = ReturnType<typeof fundStats>;

// ------------------------------------------------------------ Donations ----

export function recordDonation(
  db: DB,
  args: {
    fundId: string;
    amount: number;
    captureId: string;
    /** PayPal account the money landed in (omit for the default account). */
    accountId?: string;
    orderId: string;
    live: boolean;
    donorEmail?: string;
    donorName?: string;
    showName: boolean;
    at?: string;
    /** Ledger memo; defaults to a PayPal donation. */
    memo?: string;
  },
) {
  const email = (args.donorEmail || `guest-${args.orderId.toLowerCase()}@donor.local`).toLowerCase();
  let donor = db.donors.find((d) => d.email === email);
  if (!donor) {
    donor = { id: newId("dnr"), name: args.donorName || "Guest donor", email, createdAt: args.at ?? nowIso() };
    db.donors.push(donor);
  }
  if (args.showName && args.donorName && !donor.publicName) donor.publicName = args.donorName;

  db.captures.push({
    id: args.captureId,
    accountId: args.accountId,
    orderId: args.orderId,
    donorId: donor.id,
    amount: args.amount,
    refunded: 0,
    createdAt: args.at ?? nowIso(),
    live: args.live,
  });
  const donation: Donation = {
    id: newId("don"),
    fundId: args.fundId,
    donorId: donor.id,
    amount: args.amount,
    source: "paypal",
    captureIds: [args.captureId],
    attributed: 0,
    refunded: 0,
    carriedOut: 0,
    createdAt: args.at ?? nowIso(),
  };
  db.donations.push(donation);
  const entry = appendLedger(db, {
    fundId: args.fundId,
    type: "donation",
    amount: args.amount,
    memo: args.memo ?? `Donation via PayPal`,
    actor: args.showName ? donorLabel(donor) : donorLabel({ ...donor, publicName: undefined }),
    ref: donation.id,
    paypalRef: args.captureId,
    ts: args.at,
  });
  return { donor, donation, entry };
}

// ---------------------------------------------------------- Attribution ----

/**
 * Pro-rata attribution: every withdrawal is charged to all donors in proportion
 * to how much of their gift is still unspent. This is what powers
 * "follow your dollar" and fair leftover refunds.
 */
export function attribute(db: DB, fundId: string, amount: number) {
  const pool = db.donations.filter((d) => d.fundId === fundId && donationAvailable(d) > 0);
  const weights = pool.map(donationAvailable);
  const unspent = weights.reduce((a, b) => a + b, 0);
  // Never charge a donor more than their unspent share. Money that came in
  // through a bank statement isn't tied to a PayPal donor, so any part of the
  // payout above the donors' unspent total is covered by that bank money and
  // stays unattributed (the payout itself is already checked against balance).
  const parts = splitProRata(Math.min(amount, unspent), weights);
  const out: { donationId: string; amount: number }[] = [];
  pool.forEach((d, i) => {
    if (parts[i] > 0) {
      d.attributed += parts[i];
      out.push({ donationId: d.id, amount: parts[i] });
    }
  });
  return out;
}

// ---------------------------------------------------------- Withdrawals ----

export function requiredApprovals(fund: Fund, w: Withdrawal) {
  return w.amount >= fund.policy.dualApprovalThreshold ? 2 : 1;
}

export async function payWithdrawal(withdrawalId: string, actor: string) {
  const db0 = getDb();
  const w0 = db0.withdrawals.find((w) => w.id === withdrawalId);
  if (!w0) throw new Error("Withdrawal not found");
  return withLock(`fund:${w0.fundId}`, async () => {
    const db = getDb();
    const w = db.withdrawals.find((x) => x.id === withdrawalId)!;
    const fund = findFund(db, w.fundId)!;
    const vendor = db.vendors.find((v) => v.id === w.vendorId)!;
    if (w.status === "paid") return w;
    const stats = fundStats(db, fund);
    if (stats.balance < w.amount) {
      mutate((db2) => {
        w.status = "payout_failed";
        audit(db2, { actor: SYSTEM_ACTOR, action: "withdrawal.payout_failed", fundId: fund.id, targetId: w.id, summary: `Payout of ${fmt(w.amount)} blocked: only ${fmt(stats.balance)} left in the fund`, meta: { amount: w.amount, balance: stats.balance } });
      });
      throw new Error(`Insufficient balance (${fmt(stats.balance)} available)`);
    }
    let payout;
    try {
      payout = await sendVendorPayout(fundConn(db, fund), {
        withdrawalId: w.id,
        email: vendor.paypalEmail,
        amount: w.amount,
        note: `${fund.title}: ${categoryLabel(w.category)} — ${w.purposePublic}`.slice(0, 400),
      });
    } catch (e) {
      mutate((db2) => {
        w.status = "payout_failed";
        audit(db2, { actor: SYSTEM_ACTOR, action: "withdrawal.payout_failed", fundId: fund.id, targetId: w.id, summary: `PayPal payout of ${fmt(w.amount)} to ${vendor.name} failed: ${(e as Error).message}`.slice(0, 300), meta: { amount: w.amount } });
      });
      publish({ kind: "withdrawal", fundId: fund.id, withdrawalId: w.id, status: w.status });
      throw e;
    }
    const entry = mutate((db2) => {
      w.status = "paid";
      w.paidAt = nowIso();
      w.payout = { batchId: payout.batchId, status: payout.status, live: payout.live, at: nowIso() };
      w.attribution = attribute(db2, fund.id, w.amount);
      if (w.needId && w.quantity) {
        const need = fund.needs.find((n) => n.id === w.needId);
        if (need) need.fulfilledQty += w.quantity;
      }
      audit(db2, { actor: SYSTEM_ACTOR, action: "withdrawal.paid", fundId: fund.id, targetId: w.id, summary: `Paid ${fmt(w.amount)} to ${vendor.name} via PayPal Payouts (${payout.batchId}), released by ${actor}`, meta: { amount: w.amount, batchId: payout.batchId, live: payout.live } });
      return appendLedger(db2, {
        fundId: fund.id,
        type: "withdrawal",
        amount: -w.amount,
        memo: `${categoryLabel(w.category)}: ${w.purposePublic}`,
        actor: vendor.name,
        ref: w.id,
        paypalRef: payout.batchId,
      });
    });
    publish({ kind: "ledger", fundId: fund.id, entry });
    publish({ kind: "withdrawal", fundId: fund.id, withdrawalId: w.id, status: "paid" });
    return w;
  });
}

// --------------------------------------------------------- Donor impact ----

export function donorImpact(db: DB, donorId: string) {
  const donor = db.donors.find((d) => d.id === donorId);
  if (!donor) return null;
  const donations = db.donations.filter((d) => d.donorId === donorId);
  const items = donations.map((d) => {
    const fund = findFund(db, d.fundId)!;
    const spends = db.withdrawals
      .filter((w) => w.status === "paid" && w.attribution?.some((a) => a.donationId === d.id))
      .map((w) => {
        const share = w.attribution!.find((a) => a.donationId === d.id)!.amount;
        const vendor = db.vendors.find((v) => v.id === w.vendorId);
        const need = fund.needs.find((n) => n.id === w.needId);
        const units = w.quantity ? (w.quantity * share) / w.amount : null;
        return {
          withdrawalId: w.id,
          category: w.category,
          vendor: vendor?.name ?? "Vendor",
          purpose: w.purposePublic,
          share,
          paidAt: w.paidAt,
          units: units !== null ? Math.round(units * 10) / 10 : null,
          unit: need?.unit ?? null,
          item: need?.item ?? null,
          riskScore: w.audit?.riskScore ?? null,
        };
      });
    return {
      donationId: d.id,
      fund: { id: fund.id, slug: fund.slug, title: fund.title, status: fund.status, accent: fund.accent },
      amount: d.amount,
      source: d.source,
      fromFund: d.fromFundId ? findFund(db, d.fromFundId)?.title : undefined,
      createdAt: d.createdAt,
      attributed: d.attributed,
      refunded: d.refunded,
      carriedOut: d.carriedOut,
      leftover: donationAvailable(d),
      election: d.election,
      spends: spends.sort((a, b) => b.share - a.share),
    };
  });
  return {
    donor: { id: donor.id, name: donor.name, email: donor.email, publicLabel: donorLabel(donor) },
    totals: {
      given: donations.filter((d) => d.source === "paypal").reduce((a, d) => a + d.amount, 0),
      deployed: donations.reduce((a, d) => a + d.attributed, 0),
      refunded: donations.reduce((a, d) => a + d.refunded, 0),
      unspent: donations.reduce((a, d) => a + donationAvailable(d), 0),
    },
    items,
  };
}

// --------------------------------------------------------- Fund closure ----
//
// Only an admin closes a fund, in two steps: "start" stops new money coming in,
// "finalize" closes it. At either point the admin decides where the money left
// over goes: any amount to any other open fund of the same NGO. Whatever isn't
// moved stays in the bank and stays on this fund's books as held money, so the
// dashboard keeps tracking it (and an admin can still move it later).

export type LeftoverTransfer = { fundId: string; amount: number };

export function startClosure(fundId: string, actor: string) {
  const entry = mutate((db) => {
    const fund = findFund(db, fundId)!;
    if (fund.status !== "active") throw new Error("Fund is not active");
    fund.status = "closing";
    fund.closingStartedAt = nowIso();
    const left = fundStats(db, fund).balance;
    return appendLedger(db, {
      fundId: fund.id,
      type: "fund_closing",
      amount: 0,
      memo: `Fund closing. ${fmt(left)} is still held; an admin decides whether it moves to other funds or stays in the bank on this fund.`,
      actor,
    });
  });
  publish({ kind: "ledger", fundId, entry });
  publish({ kind: "fund", fundId });
}

/** Open funds of the same NGO that leftover money can move to. */
export const leftoverTargets = (db: DB, fund: Fund) => db.funds.filter((f) => f.ngoId === fund.ngoId && f.id !== fund.id && f.status === "active");

/** Check a set of transfers against the fund's held money; throws a readable error. */
function checkTransfers(db: DB, fund: Fund, transfers: LeftoverTransfer[]) {
  const targets = new Map(leftoverTargets(db, fund).map((f) => [f.id, f]));
  const seen = new Set<string>();
  for (const t of transfers) {
    if (!Number.isInteger(t.amount) || t.amount <= 0) throw new Error("Each amount must be more than $0.00");
    if (!targets.has(t.fundId)) throw new Error("Money can only move to another open fund");
    if (seen.has(t.fundId)) throw new Error(`${targets.get(t.fundId)!.title} is listed twice`);
    seen.add(t.fundId);
  }
  const total = transfers.reduce((a, t) => a + t.amount, 0);
  const held = fundStats(db, fund).balance;
  if (total > held) throw new Error(`That is ${fmt(total)}, but only ${fmt(held)} is held`);
  return targets;
}

/**
 * Move part of a fund's held money to another fund. PayPal gifts still unspent
 * move with it pro-rata, so each donor can still follow their share in the new
 * fund; any part above that is bank money, which isn't tied to a donor.
 */
function moveOne(db: DB, fund: Fund, target: Fund, amount: number, actor: string) {
  const pool = db.donations.filter((d) => d.fundId === fund.id && donationAvailable(d) > 0);
  const parts = splitProRata(Math.min(amount, pool.reduce((a, d) => a + donationAvailable(d), 0)), pool.map(donationAvailable));
  const byDonor = new Map<string, { amount: number; captureIds: string[] }>();
  pool.forEach((d, i) => {
    if (parts[i] <= 0) return;
    d.carriedOut += parts[i];
    const cur = byDonor.get(d.donorId) ?? { amount: 0, captureIds: [] };
    cur.amount += parts[i];
    cur.captureIds.push(...d.captureIds);
    byDonor.set(d.donorId, cur);
  });
  for (const [donorId, v] of byDonor) {
    db.donations.push({
      id: newId("don"),
      fundId: target.id,
      donorId,
      amount: v.amount,
      source: "carry_forward",
      captureIds: [...new Set(v.captureIds)],
      fromFundId: fund.id,
      attributed: 0,
      refunded: 0,
      carriedOut: 0,
      createdAt: nowIso(),
    });
  }
  return [
    appendLedger(db, { fundId: fund.id, type: "carry_forward_out", amount: -amount, memo: `Leftover money moved to "${target.title}" by an admin`, actor }),
    appendLedger(db, { fundId: target.id, type: "carry_forward_in", amount, memo: `Leftover money moved in from "${fund.title}"`, actor }),
  ];
}

/** Move held money out of a closing or closed fund. */
export function moveLeftover(fundId: string, transfers: LeftoverTransfer[], actor: string) {
  return withLock(`fund:${fundId}`, async () => {
    const entries = mutate((db) => {
      const fund = findFund(db, fundId)!;
      if (fund.status === "active") throw new Error("Start closing the fund before moving its leftover money");
      if (!transfers.length) throw new Error("Choose a fund and an amount");
      const targets = checkTransfers(db, fund, transfers);
      return transfers.flatMap((t) => moveOne(db, fund, targets.get(t.fundId)!, t.amount, actor));
    });
    entries.forEach((entry) => publish({ kind: "ledger", fundId: entry.fundId, entry }));
    for (const id of new Set(entries.map((e) => e.fundId))) publish({ kind: "fund", fundId: id });
    return { moved: transfers.reduce((a, t) => a + t.amount, 0), held: fundStats(getDb(), findFund(getDb(), fundId)!).balance };
  });
}

/** Close the fund: make the admin's transfers, then keep whatever is left on the fund as held money. */
export function finalizeClosure(fundId: string, transfers: LeftoverTransfer[], actor: string) {
  return withLock(`fund:${fundId}`, async () => {
    const result = mutate((db) => {
      const fund = findFund(db, fundId)!;
      if (fund.status !== "closing") throw new Error("Start closing the fund first");
      const targets = checkTransfers(db, fund, transfers);
      const moves = transfers.flatMap((t) => moveOne(db, fund, targets.get(t.fundId)!, t.amount, actor));
      const moved = transfers.reduce((a, t) => a + t.amount, 0);
      const held = fundStats(db, fund).balance;
      fund.status = "closed";
      fund.closedAt = nowIso();
      const into = transfers.map((t) => targets.get(t.fundId)!.title);
      const closed = appendLedger(db, {
        fundId,
        type: "fund_closed",
        amount: 0,
        memo: `Fund closed. ${moved ? `${fmt(moved)} moved to ${into.join(", ")}. ` : ""}${held ? `${fmt(held)} stays in the bank, held on this fund.` : "Nothing is left on the fund."}`,
        actor,
      });
      return { entries: [...moves, closed], moved, held, into };
    });
    result.entries.forEach((entry) => publish({ kind: "ledger", fundId: entry.fundId, entry }));
    for (const id of new Set(result.entries.map((e) => e.fundId))) publish({ kind: "fund", fundId: id });
    return { moved: result.moved, held: result.held, into: result.into };
  });
}

/** What an admin needs to decide where a fund's leftover money goes. */
export function closurePreview(db: DB, fund: Fund) {
  const s = fundStats(db, fund);
  return {
    held: s.balance,
    movedOut: s.carriedOut,
    /** Part of the held money that is still-unspent PayPal gifts (the rest came in through the bank). */
    fromDonors: db.donations.filter((d) => d.fundId === fund.id).reduce((a, d) => a + donationAvailable(d), 0),
    targets: leftoverTargets(db, fund).map((f) => ({ id: f.id, title: f.title, slug: f.slug, accent: f.accent })),
  };
}
