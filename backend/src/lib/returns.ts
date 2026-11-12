import { audit } from "./audit";
import { getDb, mutate, newId, nowIso, withLock } from "./db";
import { publish } from "./events";
import { donationAvailable, donorLabel, findFund, fundStats } from "./funds";
import { appendLedger } from "./ledger";
import { fmt, splitProRata } from "./money";
import { refundCapture, sendPayout } from "./paypal";
import { connOf, DEFAULT_PAYPAL, defaultAccount, findPayPalAccount } from "./paypal-accounts";
import type { Capture, DB, Donation, DonorReturn, Fund, LedgerEntry } from "./types";

/**
 * Returning leftover money to donors who asked for it.
 *
 * An NGO can let donors tick "if money is left when the relief work ends,
 * return my share" when they give (per fund, off by default). When the fund
 * starts closing, ClearAid notes what is still held (the leftover) and what the
 * fund raised in total. A donor who asked then gets
 *
 *     leftover × (what they gave ÷ everything the fund raised)
 *
 * so ten $100 gifts count as one $1,000 donor. It's worked out per donor and
 * per PayPal account (money can only go back from the account it landed in),
 * and sent as refunds of their gifts while those are under 180 days old (PayPal's
 * limit), otherwise as one payout to their PayPal email.
 */

/** PayPal accepts refunds for 180 days; leave a margin so a refund isn't refused mid-way. */
export const REFUND_WINDOW_DAYS = 175;
const DAY = 86_400_000;

export function returnsOf(db: DB): DonorReturn[] {
  return (db.donorReturns ??= []);
}

/** Returns that still count as sent (a payout that came back, or a refusal, doesn't). */
const counts = (r: DonorReturn) => r.status !== "returned" && r.status !== "failed";

/**
 * The leftover and total raised the shares are worked out from. Taken when
 * closing starts; for funds that started closing before this existed it is
 * rebuilt from the books (held now + moved out + already returned).
 */
export function returnBase(db: DB, fund: Fund): { leftover: number; raised: number; at: string } | null {
  if (fund.returnBase) return fund.returnBase;
  if (fund.status === "active") return null;
  const s = fundStats(db, fund);
  const sent = returnsOf(db).filter((r) => r.fundId === fund.id && counts(r)).reduce((a, r) => a + r.amount, 0);
  return { leftover: Math.max(0, s.balance + s.carriedOut + sent), raised: s.raised, at: fund.closingStartedAt ?? nowIso() };
}

export type ReturnRow = {
  key: string;
  donorId: string;
  donor: string;
  /** Where a payout would go (admins only). */
  email: string | null;
  accountId: string;
  accountName: string;
  gifts: number;
  /** What they gave through this account, less refunds made outside ClearAid's returns. */
  given: number;
  /** Their share of everything the fund raised, 0–100. */
  sharePct: number;
  /** Their share of the leftover. */
  owed: number;
  /** Already sent (and not come back). */
  sent: number;
  /** Still to send. */
  remaining: number;
  /** How it would be sent now. */
  method: "refund" | "payout";
  oldestGiftDays: number;
  /** Why it can't be sent automatically, if it can't. */
  blocker?: string;
};

type Group = { donorId: string; accountId: string; donations: Donation[]; captures: Capture[] };

function groups(db: DB, fund: Fund) {
  const out = new Map<string, Group>();
  for (const d of db.donations) {
    if (d.fundId !== fund.id || d.source !== "paypal" || !d.returnOptIn) continue;
    const caps = d.captureIds.map((id) => db.captures.find((c) => c.id === id)).filter((c): c is Capture => Boolean(c));
    const accountId = caps[0]?.accountId ?? DEFAULT_PAYPAL;
    const key = `${d.donorId}|${accountId}`;
    const g = out.get(key) ?? { donorId: d.donorId, accountId, donations: [], captures: [] };
    g.donations.push(d);
    g.captures.push(...caps);
    out.set(key, g);
  }
  return out;
}

const refundable = (c: Capture) => c.amount - c.refunded;

/**
 * Who asked for their share back and what each is owed. `prefer: "payout"`
 * sends everyone one payout even when their gifts could still be refunded.
 */
export function returnPlan(db: DB, fund: Fund, prefer: "auto" | "payout" = "auto", now = Date.now()) {
  const base = returnBase(db, fund);
  const sentBy = new Map<string, number>();
  for (const r of returnsOf(db)) {
    if (r.fundId !== fund.id || !counts(r)) continue;
    const key = `${r.donorId}|${r.accountId ?? DEFAULT_PAYPAL}`;
    sentBy.set(key, (sentBy.get(key) ?? 0) + r.amount);
  }
  const rows: ReturnRow[] = [];
  for (const [key, g] of groups(db, fund)) {
    const donor = db.donors.find((d) => d.id === g.donorId);
    const account = findPayPalAccount(db, fund.ngoId, g.accountId) ?? defaultAccount(fund.ngoId);
    // Refunds made outside these returns (e.g. in the PayPal dashboard) reduce what counts as given.
    const given = g.donations.reduce((a, d) => a + d.amount - d.refunded, 0);
    const owed = base && base.raised > 0 ? Math.min(given, Math.floor((base.leftover * given) / base.raised)) : 0;
    const sent = sentBy.get(key) ?? 0;
    const remaining = Math.max(0, owed - sent);
    const ages = g.captures.map((c) => (now - Date.parse(c.createdAt)) / DAY);
    const oldest = ages.length ? Math.max(...ages) : 0;
    const allRecent = ages.length > 0 && ages.every((a) => a < REFUND_WINDOW_DAYS);
    const canRefund = allRecent && g.captures.reduce((a, c) => a + refundable(c), 0) >= remaining;
    const method: ReturnRow["method"] = prefer === "auto" && canRefund ? "refund" : "payout";
    const newest = [...g.captures].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const email = newest?.payerEmail ?? donor?.email ?? null;
    const usableEmail = email && !email.endsWith("@donor.local") ? email : null;
    let blocker: string | undefined;
    if (method === "payout" && !usableEmail) blocker = "No PayPal email on record for a payout";
    if (method === "payout" && account.mode === "partner") blocker = `PayPal doesn't let ClearAid send payouts from ${account.name} (connected by login): send it from that PayPal account and record it`;
    if (account.status !== "active") blocker = `${account.name} is disconnected`;
    rows.push({
      key,
      donorId: g.donorId,
      donor: donor ? (donor.publicName ?? donor.name) : "Donor",
      email: usableEmail,
      accountId: g.accountId,
      accountName: account.name,
      gifts: g.donations.length,
      given,
      sharePct: base && base.raised > 0 ? (given / base.raised) * 100 : 0,
      owed,
      sent,
      remaining,
      method,
      oldestGiftDays: Math.floor(oldest),
      ...(blocker ? { blocker } : {}),
    });
  }
  rows.sort((a, b) => b.remaining - a.remaining || a.donor.localeCompare(b.donor));
  const remaining = rows.reduce((a, r) => a + r.remaining, 0);
  return { base, rows, remaining, sent: rows.reduce((a, r) => a + r.sent, 0), donors: new Set(rows.map((r) => r.donorId)).size };
}

/** Money on the fund that belongs to donors who asked for their share back and hasn't gone yet. */
export function owedToDonors(db: DB, fund: Fund) {
  if (fund.status === "active") return 0;
  return returnPlan(db, fund).remaining;
}

/** Donors who have asked so far (for the settings screen). */
export function optInCount(db: DB, fund: Fund) {
  const donors = new Set(db.donations.filter((d) => d.fundId === fund.id && d.source === "paypal" && d.returnOptIn).map((d) => d.donorId));
  return donors.size;
}

/** Spread an amount over a donor's gifts in proportion to what's still unspent on each. */
function spread(donations: Donation[], amount: number) {
  const avail = donations.map((d) => Math.max(0, donationAvailable(d)));
  const parts = splitProRata(Math.min(amount, avail.reduce((a, b) => a + b, 0)), avail);
  return donations.map((d, i) => ({ donationId: d.id, amount: parts[i] })).filter((p) => p.amount > 0);
}

/**
 * Send every return still owed (rows with a blocker are skipped). Each one is
 * sent to PayPal first and recorded after, one by one, so a refusal on one
 * donor doesn't stop the rest. Returns what happened to each.
 */
export function sendReturns(fundId: string, actor: { id: string; name: string }, prefer: "auto" | "payout" = "auto") {
  return withLock(`fund:${fundId}`, async () => {
    const db0 = getDb();
    const fund = findFund(db0, fundId);
    if (!fund) throw new Error("Fund not found");
    if (fund.status === "active") throw new Error("Start closing the fund first");
    const plan = returnPlan(db0, fund, prefer);
    const todo = plan.rows.filter((r) => r.remaining > 0 && !r.blocker);
    if (!todo.length) throw new Error(plan.rows.some((r) => r.remaining > 0) ? "The returns still owed can't be sent automatically; see the list" : "Nothing is owed to donors");
    const total = todo.reduce((a, r) => a + r.remaining, 0);
    const held = fundStats(db0, fund).balance;
    if (total > held) throw new Error(`${fmt(total)} is owed but only ${fmt(held)} is held on the fund`);

    const results: { donor: string; amount: number; method: DonorReturn["method"]; status: DonorReturn["status"]; error?: string }[] = [];
    const entries: LedgerEntry[] = [];
    for (const row of todo) {
      const db = getDb();
      const account = findPayPalAccount(db, fund.ngoId, row.accountId) ?? defaultAccount(fund.ngoId);
      const conn = connOf(account);
      const id = newId("ret");
      const note = `Your share of what was left in "${fund.title}" when the relief work ended, as you asked when you gave.`;
      let sent = 0;
      let error: string | undefined;
      let live = conn.live;
      const refunds: NonNullable<DonorReturn["refunds"]> = [];
      let payout: DonorReturn["payout"];

      if (row.method === "refund") {
        // Newest gifts first, so as few gifts as possible are touched.
        const g = groups(db, fund).get(row.key)!;
        const caps = [...g.captures].filter((c) => refundable(c) > 0).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        let left = row.remaining;
        for (const c of caps) {
          if (left <= 0) break;
          const part = Math.min(left, refundable(c));
          try {
            const r = await refundCapture(conn, c.id, part, note);
            refunds.push({ captureId: c.id, refundId: r.id, amount: part });
            live = r.live;
            sent += part;
            left -= part;
          } catch (e) {
            error = (e as Error).message;
            break;
          }
        }
      } else {
        try {
          const p = await sendPayout(conn, {
            itemId: id,
            email: row.email!,
            amount: row.remaining,
            note,
            subject: `Your share of the leftover from ${fund.title}`.slice(0, 255),
            message: `When you gave to ${fund.title}, you asked for your share of any money left at the end. Here it is.`,
          });
          payout = { batchId: p.batchId, email: row.email!, status: p.status };
          live = p.live;
          sent = row.remaining;
        } catch (e) {
          error = (e as Error).message;
        }
      }

      const status: DonorReturn["status"] = !sent ? "failed" : row.method === "payout" && live ? "sent" : "completed";
      const recorded = mutate((db) => {
        const f = findFund(db, fund.id)!;
        const g = groups(db, f).get(row.key);
        const parts = g && sent ? spread(g.donations, sent) : [];
        for (const p of parts) {
          const d = db.donations.find((x) => x.id === p.donationId)!;
          d.returned = (d.returned ?? 0) + p.amount;
        }
        for (const r of refunds) {
          const c = db.captures.find((x) => x.id === r.captureId);
          if (c) c.refunded += r.amount;
        }
        const ret: DonorReturn = {
          id,
          ngoId: f.ngoId,
          fundId: f.id,
          donorId: row.donorId,
          ...(row.accountId !== DEFAULT_PAYPAL ? { accountId: row.accountId } : {}),
          amount: sent,
          method: row.method,
          status,
          ...(refunds.length ? { refunds } : {}),
          ...(payout ? { payout } : {}),
          ...(parts.length ? { parts } : {}),
          live,
          ...(error ? { error: error.slice(0, 300) } : {}),
          createdAt: nowIso(),
          byName: actor.name,
        };
        returnsOf(db).push(ret);
        if (!sent) return null;
        const donor = db.donors.find((d) => d.id === row.donorId);
        return appendLedger(db, {
          fundId: f.id,
          type: "refund",
          amount: -sent,
          memo: `Leftover returned to a donor who asked for it when they gave (${row.sharePct.toFixed(2)}% of what the fund raised) · ${row.method === "refund" ? `PayPal refund of ${refunds.length} gift${refunds.length === 1 ? "" : "s"}` : "PayPal payout"}${live ? "" : " (simulated)"}`,
          actor: donorLabel(donor),
          ref: id,
          paypalRef: row.method === "refund" ? refunds.map((r) => r.refundId).join(",") : payout?.batchId,
        });
      });
      if (recorded) entries.push(recorded);
      results.push({ donor: row.donor, amount: sent, method: row.method, status, ...(error ? { error } : {}) });
    }

    const sentTotal = results.reduce((a, r) => a + r.amount, 0);
    const failed = results.filter((r) => r.status === "failed").length;
    mutate((db) =>
      audit(db, {
        actor,
        action: "fund.donor_returns_sent",
        fundId,
        targetId: fundId,
        summary: `Returned ${fmt(sentTotal)} of ${fund.title}'s leftover to ${results.length - failed} donor${results.length - failed === 1 ? "" : "s"} who asked for their share${failed ? `; ${failed} couldn't be sent` : ""}`,
        meta: { sent: sentTotal, donors: results.length, failed },
      }),
    );
    entries.forEach((entry) => publish({ kind: "ledger", fundId, entry }));
    publish({ kind: "fund", fundId });
    return { sent: sentTotal, results };
  });
}

/**
 * A payout webhook about a donor return. When the money comes back to the NGO
 * (unclaimed for 30 days, refused, blocked, reversed) it goes back on the fund
 * and the donor shows as owed again, so it can be sent another way.
 */
export function applyReturnPayoutEvent(db: DB, itemId: string, payoutStatus: string): LedgerEntry | null {
  const r = returnsOf(db).find((x) => x.id === itemId);
  if (!r || r.method !== "payout") return null;
  const s = payoutStatus.toUpperCase();
  if (r.payout) r.payout.status = s;
  if (s === "SUCCESS" || s === "SUCCEEDED") {
    if (r.status === "sent" || r.status === "unclaimed") r.status = "completed";
    return null;
  }
  if (s === "UNCLAIMED") {
    if (r.status === "sent") r.status = "unclaimed";
    return null;
  }
  if (!["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED"].includes(s) || r.status === "returned" || r.status === "failed") return null;
  r.status = "returned";
  for (const p of r.parts ?? []) {
    const d = db.donations.find((x) => x.id === p.donationId);
    if (d) d.returned = Math.max(0, (d.returned ?? 0) - p.amount);
  }
  return appendLedger(db, {
    fundId: r.fundId,
    type: "refund_reversed",
    amount: r.amount,
    memo: `A leftover payout to a donor came back (${s.toLowerCase()}); the money is on the fund again`,
    actor: "PayPal",
    ref: r.id,
    paypalRef: r.payout?.batchId,
  });
}

/** One return, for the closing screen (admins). */
export function returnView(db: DB, r: DonorReturn) {
  const donor = db.donors.find((d) => d.id === r.donorId);
  const account = findPayPalAccount(db, r.ngoId, r.accountId) ?? defaultAccount(r.ngoId);
  return {
    id: r.id,
    donor: donor ? (donor.publicName ?? donor.name) : "Donor",
    account: account.name,
    amount: r.amount,
    method: r.method,
    status: r.status,
    live: r.live,
    error: r.error,
    at: r.createdAt,
    by: r.byName,
  };
}
