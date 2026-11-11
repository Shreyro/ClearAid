/**
 * Add simulated test transactions to the ClearAid data: PayPal donations from
 * many donors into the open funds (each landing in the PayPal account its fund
 * uses, so the NGO's second account gets some too), then payments to the
 * funds' vendors, which are approved and paid out the same way the app does it.
 *
 * Nothing touches PayPal: the script never reads .env, so every PayPal account
 * is in simulated mode here and all IDs start with "SIM-".
 *
 *   npm run seed:transactions                       # 40 donations, 8 vendor payments
 *   npm run seed:transactions -- --donations 80 --payments 15 --hours 48 --seed 7
 *
 * Stop the backend first (it keeps the data in memory and would overwrite the
 * file). A backup of db.json is written next to it before anything changes.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/lib/config";
import { getDb, mutate, newId, nowIso } from "../src/lib/db";
import { fundStats, payWithdrawal, recordDonation, requiredApprovals } from "../src/lib/funds";
import { fmt } from "../src/lib/money";
import { DEFAULT_PAYPAL, fundAccount } from "../src/lib/paypal-accounts";
import type { Fund, Withdrawal } from "../src/lib/types";

// ------------------------------------------------------------- options ----

function arg(name: string, fallback: number) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : fallback;
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} must be a non-negative number`);
  return v;
}
const DONATIONS = arg("donations", 40);
const PAYMENTS = arg("payments", 8);
const HOURS = arg("hours", 24);
const SEED = arg("seed", Date.now() % 100000);

// Small seeded random generator, so a run can be repeated with --seed.
let s = SEED >>> 0 || 1;
const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];

const FIRST = ["Aanya", "Ben", "Chloe", "Dev", "Elena", "Farid", "Grace", "Hiro", "Isha", "Jonas", "Kavya", "Liam", "Mei", "Noah", "Olivia", "Priya", "Quinn", "Rohan", "Sara", "Tomás", "Uma", "Vikram", "Wen", "Yusuf", "Zara"];
const LAST = ["Shah", "Okafor", "Nguyen", "Fischer", "Rao", "Kim", "Patel", "Haddad", "Silva", "Brennan", "Iyer", "Lopez", "Tanaka", "Mensah", "Novak"];
const ORGS = ["Harbor Foundation", "Northwind Labs", "Riverbend Rotary", "Kestrel Partners", "Lumen Credit Union"];
// Mostly small gifts, a few large ones (whole dollars).
const AMOUNTS = [10, 15, 20, 25, 25, 30, 40, 50, 50, 50, 75, 100, 100, 150, 200, 250, 500, 1000];

// ------------------------------------------------------------- checks ----

async function backendRunning() {
  const port = Number(process.env.PORT || 4000);
  try {
    await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(1500) });
    return port;
  } catch {
    return 0;
  }
}

async function main() {
  const port = await backendRunning();
  if (port) {
    console.error(`The backend is running on port ${port}. Stop it first (it would overwrite these changes), then run this again.`);
    process.exit(1);
  }

  const file = path.join(config.dataDir, "db.json");
  if (fs.existsSync(file)) {
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(file, backup);
    console.log(`Backup: ${path.relative(process.cwd(), backup)}`);
  }

  const db = getDb();
  const funds = db.funds.filter((f) => f.status === "active");
  if (!funds.length) throw new Error("There are no open funds to add transactions to");
  const admins = db.ngos.flatMap((n) => n.members.map((m) => ({ ...m, ngoId: n.id }))).filter((m) => m.role === "admin" && m.active);

  // ------------------------------------------------------- donations ----
  // Spread over the last --hours, in time order and after the newest ledger
  // line, so every fund's hash chain stays in order. Payouts come after.
  const newest = Math.max(0, ...db.ledger.map((l) => Date.parse(l.ts)));
  const end = Date.now() - 5 * 60_000;
  const start = Math.max(end - HOURS * 3600_000, newest + 60_000);
  const times = Array.from({ length: DONATIONS }, () => start + rand() * Math.max(0, end - start)).sort((a, b) => a - b);

  const donors = Array.from({ length: Math.max(8, Math.ceil(DONATIONS * 0.6)) }, (_, i) => {
    if (i < ORGS.length && rand() < 0.5) {
      const org = ORGS[i];
      return { name: org, email: `giving@${org.toLowerCase().replace(/[^a-z]+/g, "")}.example`, big: true };
    }
    const first = pick(FIRST), last = pick(LAST);
    return { name: `${first} ${last}`, email: `${first}.${last}.${i}`.toLowerCase().normalize("NFD").replace(/[^a-z0-9.]/g, "") + "@donors.example", big: false };
  });

  const perAccount = new Map<string, { name: string; count: number; total: number }>();
  mutate((db) => {
    times.forEach((t, i) => {
      const fund = pick(funds);
      const donor = pick(donors);
      const amount = (donor.big ? pick([500, 1000, 2500, 5000]) : pick(AMOUNTS)) * 100;
      const account = fundAccount(db, fund);
      const tag = `${String(SEED).padStart(5, "0")}-${String(i + 1).padStart(3, "0")}`;
      recordDonation(db, {
        fundId: fund.id,
        amount,
        captureId: `SIM-CAP-${tag}-${newId("x").slice(2, 10).toUpperCase()}`,
        orderId: `SIM-ORDER-${tag}`,
        accountId: account.id === DEFAULT_PAYPAL ? undefined : account.id,
        live: false,
        donorEmail: donor.email,
        donorName: donor.name,
        showName: rand() < 0.65,
        at: new Date(t).toISOString(),
        memo: "Donation via PayPal (simulated) · test data",
      });
      const row = perAccount.get(account.id) ?? { name: account.name, count: 0, total: 0 };
      row.count++;
      row.total += amount;
      perAccount.set(account.id, row);
    });
  });
  console.log(`\nDonations: ${DONATIONS} from ${new Set(donors.map((d) => d.email)).size} possible donors`);
  for (const r of perAccount.values()) console.log(`  ${r.name}: ${r.count} gifts, ${fmt(r.total)}`);

  // ---------------------------------------------------- vendor payments ----
  // A request against one of the fund's needs, approved by as many admins as
  // its policy asks for, then paid through the app's own payout path.
  let paid = 0, skipped = 0;
  for (let i = 0; i < PAYMENTS; i++) {
    const fund: Fund = pick(funds);
    const vendors = db.vendors.filter((v) => fund.vendorIds.includes(v.id));
    const options = fund.needs.filter((n) => n.fulfilledQty < n.targetQty && vendors.some((v) => v.category === n.category));
    const need = options.length ? pick(options) : undefined;
    const balance = fundStats(db, fund).balance;
    if (!need || balance < need.unitCost) {
      skipped++;
      continue;
    }
    const vendor = pick(vendors.filter((v) => v.category === need.category));
    // Aim for $300-$4,000, within the need's remaining quantity and the fund's balance.
    const want = 30_000 + rand() * 370_000;
    const qty = Math.max(1, Math.min(need.targetQty - need.fulfilledQty, Math.floor(Math.min(want, balance * 0.5) / need.unitCost)));
    const amount = qty * need.unitCost;
    const purpose = `${qty.toLocaleString()} ${need.unit} of ${need.item.toLowerCase()} (test data)`;

    const w = mutate((db) => {
      const f = db.funds.find((x) => x.id === fund.id)!;
      const w: Withdrawal = {
        id: newId("wd"),
        fundId: f.id,
        vendorId: vendor.id,
        amount,
        category: need.category,
        needId: need.id,
        quantity: qty,
        location: vendor.location,
        purposeRaw: purpose,
        purposePublic: purpose,
        piiFound: [],
        receiptFileIds: [],
        photoFileIds: [],
        status: "pending_approval",
        approvals: [],
        createdAt: nowIso(),
      };
      const ngoAdmins = admins.filter((a) => a.ngoId === f.ngoId);
      for (const a of ngoAdmins.slice(0, requiredApprovals(f, w))) w.approvals.push({ by: a.id, name: a.name, decision: "approve", note: "Test data", at: nowIso() });
      db.withdrawals.push(w);
      return w;
    });
    try {
      await payWithdrawal(w.id, w.approvals.map((a) => a.name).join(" and ") || "Test data");
      paid++;
      console.log(`  Paid ${fmt(amount).padStart(10)} to ${vendor.name} from ${fund.title}`);
    } catch (e) {
      skipped++;
      console.log(`  Not paid (${(e as Error).message}): ${fmt(amount)} to ${vendor.name}`);
    }
  }
  console.log(`\nVendor payments: ${paid} paid${skipped ? `, ${skipped} skipped` : ""}`);
  console.log(`\nDone (seed ${SEED}). Start the backend again to see them.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
