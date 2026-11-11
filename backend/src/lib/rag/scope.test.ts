import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { Session } from "../types";

// Seed into a throwaway DATA_DIR before any app module is loaded.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearaid-scope-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-secret";
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { getDb } = await import("../db");
const { scopeFor, fundsMentioned } = await import("./scope");
const { buildIndexes, fundIndex, untracedIndex } = await import("./docs");

const db = getDb();
const as = (id: string, memberRole: Session["memberRole"]): Session => ({ role: "ngo", id, memberRole });
const fundIds = (s: ReturnType<typeof scopeFor>) => s.funds.map((f) => f.id).sort();

test("an admin may search every fund in full detail, plus untraced bank lines", () => {
  const s = scopeFor(db, as("adm_priya", "admin"));
  assert.deepEqual(fundIds(s), db.funds.map((f) => f.id).sort());
  assert.equal(s.audience, "staff");
  assert.ok(s.indexes.includes(untracedIndex("ngo_crc")));
});

test("staff may search only the funds they're assigned to", () => {
  const daniel = scopeFor(db, as("adm_daniel", "user"));
  assert.deepEqual(fundIds(daniel), db.funds.filter((f) => f.assignees.includes("adm_daniel")).map((f) => f.id).sort());
  const meera = scopeFor(db, as("adm_meera", "user")); // assigned to nothing
  assert.deepEqual(fundIds(meera), []);
  assert.deepEqual(meera.indexes, [untracedIndex("ngo_crc")]);
});

test("a donor may search only the funds an admin assigned, and only the public (redacted) passages", () => {
  const s = scopeFor(db, as("dnr_maya", "donor"));
  assert.deepEqual(fundIds(s), ["fund_asha"]);
  assert.equal(s.audience, "public");
  assert.deepEqual(s.indexes, [fundIndex("fund_asha", "public")]);
  assert.ok(!s.indexes.some((n) => n.endsWith(":staff") || n.startsWith("ngo:")));
});

test("taking a donor off a fund removes it from what they can ask about", () => {
  const asha = db.funds.find((f) => f.id === "fund_asha")!;
  const before = asha.viewers;
  asha.viewers = [];
  try {
    assert.deepEqual(scopeFor(db, as("dnr_maya", "donor")).indexes, []);
  } finally {
    asha.viewers = before;
  }
});

test("signed-out sessions get nothing", () => {
  assert.deepEqual(scopeFor(db, { role: "public" }).indexes, []);
});

test("public passages never carry staff-only detail", () => {
  const idx = buildIndexes(db);
  for (const f of db.funds) {
    const pub = idx[fundIndex(f.id, "public")].map((d) => d.text).join("\n");
    for (const w of db.withdrawals.filter((x) => x.fundId === f.id && x.purposeRaw !== x.purposePublic)) {
      assert.ok(!pub.includes(w.purposeRaw), `raw purpose of ${w.id} leaked into the public index`);
    }
    // Bank-line receipts and declared-payment receipts are private files (the request audit summary is public, as on the spend page).
    const privateKinds = idx[fundIndex(f.id, "public")].filter((d) => d.id.startsWith("bank:") || d.id.startsWith("pay:")).map((d) => d.text).join(" | ");
    assert.ok(!/Receipt from |Receipt items:|Recorded by /.test(privateKinds), "receipt contents or recorder leaked into the public index");
  }
});

test("questions are matched to funds by name and tracking code", () => {
  const titles = (q: string) => fundsMentioned(q, db.funds).map((f) => f.id).sort();
  assert.deepEqual(titles("Where did the Asha money go?"), ["fund_asha"]);
  assert.deepEqual(titles("spending on #RO2"), ["fund_monsoon"]);
  assert.deepEqual(titles("compare asha and mahanadi"), ["fund_asha", "fund_mahanadi"]);
  assert.deepEqual(titles("how much was spent on food overall?"), []);
});
