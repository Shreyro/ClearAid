import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearaid-banksync-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-secret";
delete process.env.PLAID_CLIENT_ID;
delete process.env.PLAID_SECRET;
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { getDb, mutate, newId, nowIso } = await import("./db");
const { checkWebhookJwt, encryptToken } = await import("./plaid");
const { plaidItems, setHealth, splitByAccount, syncAll } = await import("./bank-sync");
type BankAccount = import("./types").BankAccount;

// ------------------------------------------------------- webhook signature ----

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwtFor(body: string, iat = Math.floor(Date.now() / 1000), key = privateKey) {
  const head = b64({ alg: "ES256", kid: "k1", typ: "JWT" });
  const claims = b64({ iat, request_body_sha256: createHash("sha256").update(body).digest("hex") });
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${claims}.${sig}`;
}

test("a Plaid webhook is trusted only with a valid signature, a fresh date and the exact body", () => {
  const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item_1" });
  assert.equal(checkWebhookJwt(body, jwtFor(body), publicKey), true);
  assert.equal(checkWebhookJwt(body.replace("item_1", "item_2"), jwtFor(body), publicKey), false, "body changed");
  assert.equal(checkWebhookJwt(body, jwtFor(body, Math.floor(Date.now() / 1000) - 600), publicKey), false, "older than 5 minutes");
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
  assert.equal(checkWebhookJwt(body, jwtFor(body, undefined, other.privateKey), publicKey), false, "signed with another key");
  assert.equal(checkWebhookJwt(body, "not.a.jwt", publicKey), false);
});

// ------------------------------------------------------- one login, many accounts ----

function plaidAccount(itemId: string, accountId?: string): BankAccount {
  return {
    id: newId("bank"),
    ngoId: "ngo_crc",
    name: `Test bank ${accountId ?? "all"}`,
    provider: "plaid",
    institution: "Test bank",
    currency: "USD",
    status: "active",
    createdAt: nowIso(),
    createdBy: "adm_priya",
    feePatterns: [],
    plaid: { itemId, accessTokenEnc: encryptToken("x"), accounts: [], ...(accountId ? { accountId } : {}), simulated: false },
  };
}
const row = (plaidAccountId: string, amount: number) => ({ plaidAccountId, date: "2026-11-01", amount, description: `line ${plaidAccountId}`, reference: newId("t") });

test("one bank login's lines go to the account each belongs to", () => {
  const checking = plaidAccount("item_x", "acc_chk");
  const savings = plaidAccount("item_x", "acc_sav");
  const parts = splitByAccount([checking, savings], [row("acc_chk", 100), row("acc_sav", 200), row("acc_chk", 300)]);
  assert.deepEqual(parts.get(checking.id)!.map((r) => r.amount), [100, 300]);
  assert.deepEqual(parts.get(savings.id)!.map((r) => r.amount), [200]);
});

test("an older connection that follows the whole login takes what no other account claims", () => {
  const whole = plaidAccount("item_y");
  const savings = plaidAccount("item_y", "acc_sav");
  const parts = splitByAccount([whole, savings], [row("acc_chk", 100), row("acc_sav", 200)]);
  assert.deepEqual(parts.get(whole.id)!.map((r) => r.amount), [100]);
  assert.deepEqual(parts.get(savings.id)!.map((r) => r.amount), [200]);
});

// ------------------------------------------------------- syncing every bank ----

test("sync all pulls from every connected bank and marks it healthy", async () => {
  const sim: BankAccount = { ...plaidAccount(`sim_${newId("item")}`), name: "Simulated", plaid: { itemId: `sim_${newId("item")}`, accessTokenEnc: encryptToken("simulated"), accounts: [], simulated: true } };
  mutate((db) => db.bankAccounts.push(sim));
  const before = getDb().bankTxns.filter((t) => t.accountId === sim.id).length;
  const first = await syncAll({ id: "adm_priya", name: "Priya" }, { ngoId: "ngo_crc" });
  const mine = first.find((r) => r.itemId === sim.plaid!.itemId)!;
  assert.equal(mine.error, undefined);
  assert.ok(mine.imported > 0, "the first sync brings in history");
  assert.equal(getDb().bankTxns.filter((t) => t.accountId === sim.id).length, before + mine.imported);
  assert.equal(getDb().bankAccounts.find((a) => a.id === sim.id)!.plaid!.health!.status, "ok");

  const live = await syncAll({ id: "adm_priya", name: "Priya" }, { ngoId: "ngo_crc", liveOnly: true });
  assert.ok(!live.some((r) => r.itemId === sim.plaid!.itemId), "the timer leaves simulated banks alone");
});

test("a bank that needs logging in again is flagged, and cleared when it's fixed", () => {
  const a = plaidAccount("item_z", "acc_1");
  mutate((db) => db.bankAccounts.push(a));
  mutate((db) => setHealth(db, "item_z", { status: "reconnect", reason: "ITEM_LOGIN_REQUIRED", at: nowIso() }));
  assert.equal(getDb().bankAccounts.find((x) => x.id === a.id)!.plaid!.health!.status, "reconnect");
  assert.ok(getDb().auditLog.some((e) => e.action === "bank.reconnect_needed"));
  mutate((db) => setHealth(db, "item_z", { status: "ok", at: nowIso() }));
  assert.ok(getDb().auditLog.some((e) => e.action === "bank.reconnected"));
  assert.ok(plaidItems(getDb(), "ngo_crc").has("item_z"));
});
