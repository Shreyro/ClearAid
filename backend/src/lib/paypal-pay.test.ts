import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearaid-pay-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-secret";
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { getDb, mutate } = await import("./db");
const { findFund, fundStats } = await import("./funds");
const { payoutCameBack, sendPayPalPayment } = await import("./paypal-pay");
const { paypalReconciliation } = await import("./transfers");
type Me = import("./session").SignedInMember;

const priya: Me = { id: "adm_priya", name: "Priya", title: "Admin", role: "admin", ngoId: "ngo_crc", ngoName: "Coastal Relief Collective", canPay: true };
const daniel = (canPay: boolean): Me => ({ id: "adm_daniel", name: "Daniel", title: "Staff", role: "user", ngoId: "ngo_crc", ngoName: "Coastal Relief Collective", canPay });
const pay = { fundId: "fund_asha", amount: 12_500, payee: "Puri Boat Hire", email: "boats@vendors.example", description: "Boat hire for two days" };
const balance = () => fundStats(getDb(), findFund(getDb(), "fund_asha")!).balance;

test("staff without the permission can't send PayPal payments", async () => {
  await assert.rejects(sendPayPalPayment(daniel(false), pay), /aren't allowed/);
});

test("staff with the permission can only pay from funds they're on", async () => {
  mutate((db) => {
    const f = db.funds.find((x) => x.id === "fund_monsoon")!;
    f.assignees = f.assignees.filter((id) => id !== "adm_daniel");
  });
  await assert.rejects(sendPayPalPayment(daniel(true), { ...pay, fundId: "fund_monsoon" }), /not on/);
});

test("a payment can't be more than the fund holds", async () => {
  // The fund holding the least, so the check isn't hidden by the $10,000 per-payout limit.
  const low = getDb().funds.filter((f) => f.status !== "closed").map((f) => ({ f, b: fundStats(getDb(), f).balance })).sort((a, b) => a.b - b.b)[0];
  assert.ok(low.b + 100 <= 10_000_00, "the demo has a fund holding under $10,000");
  await assert.rejects(sendPayPalPayment(priya, { ...pay, fundId: low.f.id, amount: low.b + 100 }), /holds/);
});

test("the payee's PayPal email and the purpose are required", async () => {
  await assert.rejects(sendPayPalPayment(priya, { ...pay, email: "not-an-email" }), /PayPal email/);
  await assert.rejects(sendPayPalPayment(priya, { ...pay, description: "x" }), /what it's for/);
});

test("an admin's payment is sent, put on the fund's ledger and counted against the PayPal account", async () => {
  const before = balance();
  const recon = paypalReconciliation(getDb(), "ngo_crc", "pp_default").paidOut;
  const r = await sendPayPalPayment(priya, pay);
  assert.equal(r.payment.method, "paypal");
  assert.equal(r.payment.payout!.email, "boats@vendors.example");
  assert.equal(r.live, false, "no PayPal keys in tests: simulated");
  assert.equal(balance(), before - 12_500);
  assert.equal(paypalReconciliation(getDb(), "ngo_crc", "pp_default").paidOut, recon + 12_500);
  assert.ok(getDb().auditLog.some((e) => e.action === "payment.paypal_sent" && e.targetId === r.payment.id));
});

test("if PayPal sends the payment back, it's voided and the money returns to the fund", async () => {
  const r = await sendPayPalPayment(priya, { ...pay, amount: 5_000 });
  const before = balance();
  const entry = mutate((db) => payoutCameBack(db, r.payment.id, "RETURNED"));
  assert.ok(entry);
  assert.equal(balance(), before + 5_000);
  assert.equal(getDb().payments!.find((p) => p.id === r.payment.id)!.status, "void");
  assert.equal(mutate((db) => payoutCameBack(db, r.payment.id, "RETURNED")), null, "only once");
});
