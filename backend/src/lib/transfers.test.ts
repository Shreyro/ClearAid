import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearaid-transfers-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-secret";
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { getDb, mutate, newId, nowIso } = await import("./db");
const { ingestRows } = await import("./banking");
const { fundStats, findFund, recordDonation } = await import("./funds");
const { looksLikePayPalTransfer, paypalReconciliation, rescanTransfers } = await import("./transfers");
type BankAccount = import("./types").BankAccount;

const actor = { id: "adm_priya", name: "Priya" };
const bank: BankAccount = { id: newId("bank"), ngoId: "ngo_crc", name: "Ops ••4410", provider: "csv", institution: "Test bank", currency: "USD", status: "active", createdAt: nowIso(), createdBy: "adm_priya", feePatterns: [] };
mutate((db) => db.bankAccounts.push(bank));
const acc = () => getDb().bankAccounts.find((a) => a.id === bank.id)!;
const line = (amount: number, description: string, n: number) => ({ date: "2026-11-01", amount, description, reference: `REF-${n}` });

test("bank wording for a PayPal withdrawal is recognised; other PayPal lines aren't", () => {
  assert.equal(looksLikePayPalTransfer({ amount: 124000, description: "PAYPAL TRANSFER PPD ID: PAYPALSD11" }), true);
  assert.equal(looksLikePayPalTransfer({ amount: 5000, description: "PAYPAL INST XFER" }), true);
  assert.equal(looksLikePayPalTransfer({ amount: -5000, description: "PAYPAL TRANSFER" }), false, "money out isn't a withdrawal in");
  assert.equal(looksLikePayPalTransfer({ amount: 5000, description: "Donation via PayPal Giving Fund #ASHA" }), false);
});

test("without a link, a PayPal deposit is just an untagged line", () => {
  const r = mutate((db) => ingestRows(db, acc(), [line(50000, "PAYPAL TRANSFER PPD ID: A1", 1)], { source: "csv", actor }));
  assert.equal(getDb().bankTxns.find((t) => t.importId === r.imp.id)!.status, "untagged");
});

test("linking the PayPal account turns waiting deposits into transfers, and new ones arrive as transfers", () => {
  const marked = mutate((db) => {
    const a = db.bankAccounts.find((x) => x.id === bank.id)!;
    a.transfersFrom = ["pp_default"];
    return rescanTransfers(db, a);
  });
  assert.equal(marked, 1);
  const raised = fundStats(getDb(), findFund(getDb(), "fund_asha")!).raised;
  const r = mutate((db) => ingestRows(db, acc(), [line(30000, "PAYPAL TRANSFER PPD ID: A2", 2), line(9000, "NEFT CR donation #ASHA", 3)], { source: "csv", actor }));
  const lines = getDb().bankTxns.filter((t) => t.importId === r.imp.id);
  const transfer = lines.find((t) => t.amount === 30000)!;
  assert.equal(transfer.status, "transfer");
  assert.equal(transfer.transfer!.paypalAccountId, "pp_default");
  assert.equal(lines.find((t) => t.amount === 9000)!.status, "auto_tagged", "real money with a code is still tagged");
  assert.equal(fundStats(getDb(), findFund(getDb(), "fund_asha")!).raised, raised + 9000, "the transfer never reaches a fund");
});

test("a line someone said isn't a transfer is left alone by the rule", () => {
  mutate((db) => {
    const t = db.bankTxns.find((x) => x.accountId === bank.id && x.status === "transfer")!;
    t.status = "untagged";
    t.transfer = undefined;
    t.notTransfer = true;
    rescanTransfers(db, db.bankAccounts.find((x) => x.id === bank.id)!);
  });
  assert.equal(getDb().bankTxns.filter((t) => t.accountId === bank.id && t.notTransfer)[0].status, "untagged");
});

test("reconciliation: collected, moved to the bank, and what's still in PayPal", () => {
  const before = paypalReconciliation(getDb(), "ngo_crc", "pp_default");
  mutate((db) =>
    recordDonation(db, { fundId: "fund_asha", amount: 100000, captureId: "SIM-CAP-RECON", orderId: "SIM-ORDER-RECON", live: false, donorEmail: "recon@donors.example", showName: false }),
  );
  const after = paypalReconciliation(getDb(), "ngo_crc", "pp_default");
  assert.equal(after.collected, before.collected + 100000);
  assert.equal(after.toBank, getDb().bankTxns.filter((t) => t.status === "transfer" && t.transfer?.paypalAccountId === "pp_default").reduce((s, t) => s + t.amount, 0));
  assert.equal(after.stillInPayPal, after.collected - after.refunded - after.paidOut - after.toBank);
  assert.deepEqual(after.banks.map((b) => b.id), [bank.id]);
});

test("more arriving in the bank than the account collected is flagged", () => {
  mutate((db) => {
    const a = db.bankAccounts.find((x) => x.id === bank.id)!;
    a.transfersFrom = ["pp_appeals"];
  });
  mutate((db) => ingestRows(db, acc(), [line(999_999_00, "PAYPAL TRANSFER PPD ID: BIG", 9)], { source: "csv", actor }));
  assert.match(paypalReconciliation(getDb(), "ngo_crc", "pp_appeals").warning ?? "", /more reached the bank/);
});
