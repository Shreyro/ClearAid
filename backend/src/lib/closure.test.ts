import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The store seeds itself into DATA_DIR on first read, so pin a throwaway folder first.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearaid-closure-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-secret";
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { getDb } = await import("./db");
const { closurePreview, finalizeClosure, findFund, fundStats, moveLeftover, startClosure } = await import("./funds");

const stats = (id: string) => fundStats(getDb(), findFund(getDb(), id)!);
const total = () => getDb().funds.reduce((a, f) => a + fundStats(getDb(), f).balance, 0);

test("only other open funds of the same NGO are offered", () => {
  const p = closurePreview(getDb(), findFund(getDb(), "fund_mahanadi")!);
  assert.ok(p.held > 0);
  assert.ok(p.targets.length > 0);
  assert.ok(p.targets.every((t) => t.id !== "fund_mahanadi" && findFund(getDb(), t.id)!.status === "active"));
});

test("an active fund can't move money before closing starts", async () => {
  await assert.rejects(moveLeftover("fund_asha", [{ fundId: "fund_monsoon", amount: 100 }], "test"), /Start closing/);
});

test("transfers are checked before anything moves", async () => {
  const held = stats("fund_mahanadi").balance;
  const before = getDb().ledger.length;
  await assert.rejects(finalizeClosure("fund_mahanadi", [{ fundId: "fund_asha", amount: held + 1 }], "test"), /only .* is held/);
  await assert.rejects(finalizeClosure("fund_mahanadi", [{ fundId: "fund_mahanadi", amount: 100 }], "test"), /another open fund/);
  await assert.rejects(finalizeClosure("fund_mahanadi", [{ fundId: "fund_asha", amount: 100 }, { fundId: "fund_asha", amount: 100 }], "test"), /listed twice/);
  await assert.rejects(finalizeClosure("fund_mahanadi", [{ fundId: "fund_asha", amount: 0 }], "test"), /more than/);
  assert.equal(getDb().ledger.length, before);
  assert.equal(findFund(getDb(), "fund_mahanadi")!.status, "closing");
});

test("closing moves the chosen amounts and keeps the rest held on the fund", async () => {
  const all = total();
  const held = stats("fund_mahanadi").balance;
  const asha = stats("fund_asha").balance;
  const monsoon = stats("fund_monsoon").balance;
  const r = await finalizeClosure("fund_mahanadi", [{ fundId: "fund_asha", amount: 30000 }, { fundId: "fund_monsoon", amount: 12345 }], "test");
  assert.equal(r.moved, 42345);
  assert.equal(r.held, held - 42345);
  assert.equal(findFund(getDb(), "fund_mahanadi")!.status, "closed");
  assert.equal(stats("fund_mahanadi").balance, held - 42345);
  assert.equal(stats("fund_asha").balance, asha + 30000);
  assert.equal(stats("fund_monsoon").balance, monsoon + 12345);
  assert.equal(total(), all, "no money appears or disappears");
});

test("held money on a closed fund can still be moved later, but no further than what's held", async () => {
  const held = stats("fund_mahanadi").balance;
  await assert.rejects(moveLeftover("fund_mahanadi", [{ fundId: "fund_asha", amount: held + 1 }], "test"));
  const r = await moveLeftover("fund_mahanadi", [{ fundId: "fund_asha", amount: held }], "test");
  assert.equal(r.held, 0);
  assert.equal(stats("fund_mahanadi").balance, 0);
});

test("a fund with nowhere to move money closes with all of it held", async () => {
  const db = getDb();
  const others = db.funds.filter((f) => f.id !== "fund_asha" && f.status === "active");
  for (const f of others) f.status = "closed"; // nothing else open
  startClosure("fund_asha", "test");
  assert.equal(closurePreview(getDb(), findFund(getDb(), "fund_asha")!).targets.length, 0);
  const held = stats("fund_asha").balance;
  const r = await finalizeClosure("fund_asha", [], "test");
  assert.deepEqual(r, { moved: 0, held, into: [] });
  assert.equal(stats("fund_asha").balance, held);
});
