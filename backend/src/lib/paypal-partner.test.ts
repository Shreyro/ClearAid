import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearaid-partner-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-secret";
process.env.PAYPAL_PARTNER_CLIENT_ID = "partner-client";
process.env.PAYPAL_PARTNER_CLIENT_SECRET = "partner-secret";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNER123";
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { authAssertion } = await import("./paypal");
const { connOf } = await import("./paypal-accounts");
type PayPalAccount = import("./types").PayPalAccount;

const account = (over: Partial<PayPalAccount>): PayPalAccount => ({ id: "pp_x", ngoId: "ngo_crc", name: "Appeals", env: "sandbox", mode: "partner", status: "active", merchantId: "SELLER1", createdAt: "", createdBy: "adm_priya", ...over });

test("calls on behalf of a connected account carry an unsigned assertion naming it", () => {
  const [h, p, s] = authAssertion("partner-client", "SELLER1").split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "none" });
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url").toString()), { iss: "partner-client", payer_id: "SELLER1" });
  assert.equal(s, "", "no signature part");
});

test("an account connected by login uses the partner app's keys and acts for its merchant", () => {
  const c = connOf(account({}));
  assert.equal(c.live, true);
  assert.equal(c.clientId, "partner-client");
  assert.equal(c.actAs, "SELLER1");
});

test("it isn't live until the login is finished, or after it's disconnected", () => {
  assert.equal(connOf(account({ status: "pending", merchantId: undefined })).live, false);
  assert.equal(connOf(account({ status: "disconnected" })).live, false);
});

test("accounts with their own keys never act for anyone else", () => {
  assert.equal(connOf(account({ mode: "simulated", merchantId: undefined })).actAs, undefined);
});
