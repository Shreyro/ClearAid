import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Pin a throwaway data folder and server secret before any app module loads.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearaid-accounts-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-secret";
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { buildSeed } = await import("./seed");
const { captureConn, connOf, DEFAULT_PAYPAL, fundAccount, paypalAccountsOf, paypalAccountView } = await import("./paypal-accounts");
const { encryptToken } = await import("./plaid");
const { movementView } = await import("./movements");

const db = buildSeed(7);
const fund = (id: string) => db.funds.find((f) => f.id === id)!;

test("the demo NGO has two bank accounts and two PayPal accounts", () => {
  assert.equal(db.bankAccounts.filter((a) => a.ngoId === "ngo_crc").length, 2);
  assert.deepEqual(paypalAccountsOf(db, "ngo_crc").map((a) => a.id), [DEFAULT_PAYPAL, "pp_appeals"]);
});

test("each fund pays into its own account; no choice means the main account", () => {
  assert.equal(fundAccount(db, fund("fund_monsoon")).id, "pp_appeals");
  assert.equal(fundAccount(db, fund("fund_asha")).id, DEFAULT_PAYPAL);
});

test("a disconnected account sends new gifts to the main account", () => {
  const acc = db.paypalAccounts!.find((a) => a.id === "pp_appeals")!;
  acc.status = "disconnected";
  try {
    assert.equal(fundAccount(db, fund("fund_monsoon")).id, DEFAULT_PAYPAL);
  } finally {
    acc.status = "active";
  }
});

test("refunds go back through the account the gift landed in", () => {
  const d = db.donations.find((x) => x.fundId === "fund_monsoon" && x.source === "paypal")!;
  const cap = db.captures.find((c) => c.id === d.captureIds[0])!;
  assert.equal(captureConn(db, cap).id, "pp_appeals");
  const other = db.donations.find((x) => x.fundId === "fund_asha" && x.source === "paypal")!;
  assert.equal(captureConn(db, db.captures.find((c) => c.id === other.captureIds[0])!).id, DEFAULT_PAYPAL);
});

test("each account's totals count only its own gifts", () => {
  const views = paypalAccountsOf(db, "ngo_crc").map((a) => paypalAccountView(db, a));
  const paypalGifts = db.donations.filter((d) => d.source === "paypal" && !d.captureIds[0].startsWith("MANUAL-"));
  assert.equal(views.reduce((s, v) => s + v.gifts, 0), new Set(paypalGifts.flatMap((d) => d.captureIds)).size);
  assert.ok(views.every((v) => v.gifts > 0));
});

test("a live account's secret is stored encrypted and never in the browser view", () => {
  const acc = { id: "pp_x", ngoId: "ngo_crc", name: "Live test", env: "sandbox" as const, mode: "live" as const, clientId: "AbCdEf1234567890", clientSecretEnc: encryptToken("super-secret-value"), status: "active" as const, createdAt: "", createdBy: "t" };
  assert.ok(!acc.clientSecretEnc.includes("super-secret"));
  assert.equal(connOf(acc).clientSecret, "super-secret-value");
  assert.equal(connOf(acc).live, true);
  const view = JSON.stringify(paypalAccountView(db, acc));
  assert.ok(!view.includes("super-secret") && !view.includes(acc.clientSecretEnc) && !view.includes("AbCdEf1234567890"));
});

test("transactions name the account money came through", () => {
  const titles = new Map(db.funds.map((f) => [f.id, f.title]));
  const rows = db.ledger.map((e) => movementView(db, e, titles.get(e.fundId)!));
  const keys = new Set(rows.map((r) => r.account?.key).filter(Boolean));
  for (const k of ["paypal:pp_default", "paypal:pp_appeals", "bank:bank_main", "bank:bank_field"]) assert.ok(keys.has(k), k);
});
