import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearaid-meta-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-secret";
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { getDb, mutate } = await import("./db");
const { entryByKey, entryKey, fileInUse, hasDocument, metaOf, metaView, tagsOf } = await import("./entry-meta");

test("a transaction is found by its key, and only by a real one", () => {
  const e = getDb().ledger.find((x) => x.fundId === "fund_asha" && x.seq === 3)!;
  assert.equal(entryByKey(getDb(), entryKey(e)), e);
  assert.equal(entryByKey(getDb(), "fund_asha:999999"), undefined);
  assert.equal(entryByKey(getDb(), "nonsense"), undefined);
});

test("money out counts as documented from wherever its paperwork was attached", () => {
  const db = getDb();
  const withdrawal = db.ledger.find((e) => e.type === "withdrawal" && db.withdrawals.find((w) => w.id === e.ref)?.receiptFileIds.length)!;
  assert.equal(hasDocument(db, withdrawal), true, "a payment request's receipt");
  const bankOut = db.ledger.find((e) => e.type === "bank_out" && !db.bankTxns.find((t) => t.id === e.ref)?.receipts?.length)!;
  assert.equal(hasDocument(db, bankOut), false);
  assert.equal(hasDocument(db, bankOut, { docs: [{ fileId: "f", kind: "invoice", byId: "x", byName: "X", at: "" }] }), true, "an invoice added later");
});

test("tags and documents show by name; a file already used elsewhere is flagged", () => {
  const e = getDb().ledger.find((x) => x.type === "bank_out")!;
  const fileId = getDb().files[0].id;
  mutate((db) => {
    tagsOf(db).push({ id: "tag_boats", ngoId: "ngo_crc", name: "Boat hire", color: "sky", createdBy: "adm_priya", createdByName: "Priya", createdAt: "" });
    metaOf(db)[entryKey(e)] = { tagIds: ["tag_boats"], docs: [{ fileId, kind: "invoice", byId: "adm_priya", byName: "Priya", at: "" }] };
  });
  const v = metaView(getDb(), entryKey(e));
  assert.deepEqual(v.tags, [{ id: "tag_boats", name: "Boat hire", color: "sky" }]);
  assert.equal(v.docs[0].url, `/api/files/${fileId}`);
  assert.equal(fileInUse(getDb(), fileId), "another transaction");
});
