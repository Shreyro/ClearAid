import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The store seeds itself into DATA_DIR on first read, so pin a throwaway folder first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearaid-returns-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-secret";
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { getDb, mutate } = await import("./db");
const { findFund, fundStats, moveLeftover, recordDonation, startClosure } = await import("./funds");
const { applyReturnPayoutEvent, owedToDonors, returnPlan, returnsOf, sendReturns } = await import("./returns");

const FUND = "fund_asha";
const fund = () => findFund(getDb(), FUND)!;
const stats = () => fundStats(getDb(), fund());
const admin = { id: "adm_priya", name: "Priya" };
const DAY = 86_400_000;

let n = 0;
function give(email: string, cents: number, optIn: boolean, daysAgo = 1) {
  n++;
  mutate((db) =>
    recordDonation(db, {
      fundId: FUND,
      amount: cents,
      captureId: `SIM-CAP-TEST-${n}`,
      orderId: `SIM-ORDER-TEST-${n}`,
      live: false,
      donorEmail: email,
      donorName: email.split("@")[0],
      showName: false,
      returnOptIn: optIn,
      payerEmail: email,
      at: new Date(Date.now() - daysAgo * DAY).toISOString(),
    }),
  );
}

test("only donors who ticked the box are offered a return, and only after closing starts", () => {
  mutate((db) => {
    findFund(db, FUND)!.donorReturns = true;
  });
  for (let i = 0; i < 10; i++) give("ten.gifts@donors.example", 10_000, true); // $100 × 10
  give("no.thanks@donors.example", 50_000, false);
  give("old.gift@donors.example", 20_000, true, 200); // older than PayPal's refund window
  assert.equal(returnPlan(getDb(), fund()).rows.length, 2, "two donors asked");
  assert.equal(owedToDonors(getDb(), fund()), 0, "nothing is owed while the fund is open");
});

test("each donor gets leftover × (what they gave ÷ everything raised), counted once per donor", async () => {
  startClosure(FUND, "test");
  const base = fund().returnBase!;
  assert.equal(base.leftover, stats().balance);
  assert.equal(base.raised, stats().raised);

  const plan = returnPlan(getDb(), fund());
  const ten = plan.rows.find((r) => r.email === "ten.gifts@donors.example")!;
  assert.equal(ten.gifts, 10, "ten gifts, one row");
  assert.equal(ten.given, 100_000);
  assert.equal(ten.owed, Math.floor((base.leftover * 100_000) / base.raised));
  assert.equal(ten.method, "refund", "recent gifts are refunded");

  const old = plan.rows.find((r) => r.email === "old.gift@donors.example")!;
  assert.equal(old.method, "payout", "gifts past the refund window go back as a payout");
  assert.equal(plan.remaining, ten.owed + old.owed);
});

test("money owed to donors can't be moved to another fund", async () => {
  const held = stats().balance;
  const owed = owedToDonors(getDb(), fund());
  await assert.rejects(moveLeftover(FUND, [{ fundId: "fund_monsoon", amount: held - owed + 1 }], "test"), /owed to donors/);
});

test("sending returns pays each donor once and takes it off the fund", async () => {
  const held = stats().balance;
  const owed = owedToDonors(getDb(), fund());
  const r = await sendReturns(FUND, admin);
  assert.equal(r.sent, owed);
  assert.equal(r.results.length, 2);
  assert.ok(r.results.every((x) => x.status === "completed"));
  assert.equal(stats().balance, held - owed);
  assert.equal(owedToDonors(getDb(), fund()), 0);

  const ten = returnsOf(getDb()).find((x) => x.method === "refund")!;
  assert.ok(ten.refunds!.length >= 1 && ten.refunds!.length <= 10, "refunded across as few gifts as needed");
  assert.equal(ten.refunds!.reduce((a, x) => a + x.amount, 0), ten.amount);

  await assert.rejects(sendReturns(FUND, admin), /Nothing is owed/);
});

test("a payout that comes back puts the money on the fund and the donor is owed again", () => {
  const ret = returnsOf(getDb()).find((x) => x.method === "payout")!;
  const held = stats().balance;
  const entry = mutate((db) => applyReturnPayoutEvent(db, ret.id, "RETURNED"));
  assert.ok(entry);
  assert.equal(entry!.type, "refund_reversed");
  assert.equal(stats().balance, held + ret.amount);
  assert.equal(owedToDonors(getDb(), fund()), ret.amount);
  // The same event twice changes nothing.
  assert.equal(mutate((db) => applyReturnPayoutEvent(db, ret.id, "RETURNED")), null);
});
