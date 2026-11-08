import { createHash } from "node:crypto";
import { getDb, mutate, newId, nowIso, withLock } from "./db";
import { appendLedger, verifyChain } from "./ledger";
import { audit, SYSTEM_ACTOR } from "./audit";
import { fmt, splitProRata } from "./money";
import { publish } from "./events";
import { refundCapture, sendVendorPayout } from "./paypal";
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
  const spent = sum(["withdrawal"]) + bankOut;
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
      payout = await sendVendorPayout({
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
      memo: `Fund closing. ${fmt(left)} unspent will be refunded or carried forward under the fund's leftover policy.`,
      actor,
    });
  });
  publish({ kind: "ledger", fundId, entry });
  publish({ kind: "fund", fundId });
}

export function setElection(donorId: string, fundId: string, choice: "refund" | "carry_forward", targetFundId?: string) {
  return mutate((db) => {
    const fund = findFund(db, fundId);
    if (!fund || fund.status !== "closing") throw new Error("This fund is not collecting leftover choices");
    if (choice === "carry_forward") {
      const target = targetFundId ? findFund(db, targetFundId) : undefined;
      if (!target || target.status !== "active" || target.id === fund.id) throw new Error("Pick an active fund to carry forward to");
    }
    const ds = db.donations.filter((d) => d.donorId === donorId && d.fundId === fund.id);
    if (!ds.length) throw new Error("No donations to this fund");
    for (const d of ds) d.election = { choice, targetFundId: choice === "carry_forward" ? targetFundId : undefined, at: nowIso() };
    return ds.length;
  });
}

/** Execute every donor's leftover choice (or the policy default) and close the fund. */
export async function finalizeClosure(fundId: string, actor: string) {
  return withLock(`fund:${fundId}`, async () => {
    const db = getDb();
    const fund = findFund(db, fundId)!;
    if (fund.status !== "closing") throw new Error("Fund must be in closing state");
    const results = { refunded: 0, refunds: 0, carried: 0, carries: 0, errors: [] as string[] };

    // Group leftovers per donor so each donor gets one refund/carry entry.
    const byDonor = new Map<string, Donation[]>();
    for (const d of db.donations.filter((x) => x.fundId === fund.id && donationAvailable(x) > 0)) {
      byDonor.set(d.donorId, [...(byDonor.get(d.donorId) ?? []), d]);
    }

    for (const [donorId, ds] of byDonor) {
      const donor = db.donors.find((x) => x.id === donorId);
      const choice = ds[0].election?.choice ?? fund.policy.leftoverDefault;
      const targetId = ds[0].election?.targetFundId ?? fund.carryForwardFundId;
      const target = targetId ? findFund(db, targetId) : undefined;

      if (choice === "carry_forward" && target && target.status === "active") {
        const total = ds.reduce((a, d) => a + donationAvailable(d), 0);
        const entries = mutate((db2) => {
          for (const d of ds) d.carriedOut += donationAvailable(d);
          db2.donations.push({
            id: newId("don"),
            fundId: target.id,
            donorId,
            amount: total,
            source: "carry_forward",
            captureIds: [...new Set(ds.flatMap((d) => d.captureIds))],
            fromFundId: fund.id,
            attributed: 0,
            refunded: 0,
            carriedOut: 0,
            createdAt: nowIso(),
          });
          return [
            appendLedger(db2, {
              fundId: fund.id,
              type: "carry_forward_out",
              amount: -total,
              memo: `Leftover share carried forward to "${target.title}" at the donor's request`,
              actor: donorLabel(donor),
            }),
            appendLedger(db2, {
              fundId: target.id,
              type: "carry_forward_in",
              amount: total,
              memo: `Leftover share carried forward from "${fund.title}"`,
              actor: donorLabel(donor),
            }),
          ];
        });
        entries.forEach((entry) => publish({ kind: "ledger", fundId: entry.fundId, entry }));
        results.carried += total;
        results.carries += 1;
        continue;
      }

      // Refund: walk the donor's captures, never refunding more than PayPal holds.
      let owed = ds.reduce((a, d) => a + donationAvailable(d), 0);
      const captureIds = [...new Set(ds.flatMap((d) => d.captureIds))];
      const refundIds: string[] = [];
      let refundedTotal = 0;
      for (const capId of captureIds) {
        if (owed <= 0) break;
        const cap = db.captures.find((c) => c.id === capId);
        if (!cap) continue;
        const amt = Math.min(owed, cap.amount - cap.refunded);
        if (amt <= 0) continue;
        try {
          const r = await refundCapture(cap.id, amt, `Unspent share of your gift to ${fund.title}. Thank you.`);
          mutate(() => {
            cap.refunded += amt;
          });
          refundIds.push(r.id);
          refundedTotal += amt;
          owed -= amt;
        } catch (e) {
          results.errors.push(`${donorLabel(donor)}: ${(e as Error).message}`);
        }
      }
      if (refundedTotal > 0) {
        const entry = mutate((db2) => {
          let remaining = refundedTotal;
          for (const d of ds) {
            const take = Math.min(remaining, donationAvailable(d));
            d.refunded += take;
            remaining -= take;
          }
          return appendLedger(db2, {
            fundId: fund.id,
            type: "refund",
            amount: -refundedTotal,
            memo: "Pro-rata refund of unspent funds via PayPal",
            actor: donorLabel(donor),
            paypalRef: refundIds.join(","),
          });
        });
        publish({ kind: "ledger", fundId: fund.id, entry });
        results.refunded += refundedTotal;
        results.refunds += 1;
      }
    }

    const entry = mutate((db2) => {
      const f = findFund(db2, fundId)!;
      f.status = "closed";
      f.closedAt = nowIso();
      return appendLedger(db2, {
        fundId,
        type: "fund_closed",
        amount: 0,
        memo: `Fund closed. ${fmt(results.refunded)} refunded to ${results.refunds} donors, ${fmt(results.carried)} carried forward for ${results.carries} donors.`,
        actor,
      });
    });
    publish({ kind: "ledger", fundId, entry });
    publish({ kind: "fund", fundId });
    return results;
  });
}

/** Leftover preview for a closing fund. */
export function closurePreview(db: DB, fund: Fund) {
  const ds = db.donations.filter((d) => d.fundId === fund.id && donationAvailable(d) > 0);
  const donors = new Map<string, { leftover: number; choice: string }>();
  for (const d of ds) {
    const cur = donors.get(d.donorId) ?? { leftover: 0, choice: d.election?.choice ?? `default:${fund.policy.leftoverDefault}` };
    cur.leftover += donationAvailable(d);
    donors.set(d.donorId, cur);
  }
  const rows = [...donors.values()];
  const sumBy = (pred: (c: string) => boolean) => rows.filter((r) => pred(r.choice)).reduce((a, r) => a + r.leftover, 0);
  return {
    donors: rows.length,
    leftover: rows.reduce((a, r) => a + r.leftover, 0),
    electedRefund: sumBy((c) => c === "refund"),
    electedCarry: sumBy((c) => c === "carry_forward"),
    undecided: sumBy((c) => c.startsWith("default:")),
    defaultChoice: fund.policy.leftoverDefault,
  };
}
