import assert from "node:assert/strict";
import { test } from "node:test";
import { anonymiseBankLine } from "./anonymise";
import { codeIndex, ingestRows, matchCodes, type ParsedRow } from "./banking";
import type { BankAccount, DB, Fund } from "./types";

// Aliases are keyed with the server secret; fix it so nothing is written to DATA_DIR.
process.env.SESSION_SECRET = "test-secret";

const opts = { scope: "ngo_a", secret: "test-secret", knownOrganisations: ["Kalinga Rice & Pulses Traders"] };
const anon = (description: string, counterparty?: string) => anonymiseBankLine({ description, counterparty }, opts);
const ALIAS = /Person-[0-9A-F]{6}/;

test("organisations, fees and purpose text are left as they are", () => {
  for (const line of [
    "RTGS CR Bayfront Foundation emergency grant #RO1",
    "NEFT DR Shelter Co tarpaulins INV-443 #RO1-SHL",
    "IMPS CR Puri Traders Association #RO2",
    "NEFT CR Lions Club Cuttack flood appeal #RO2 #RO1",
    "NEFT CR Rotary Club of Puri, cyclone appeal #RO1",
    "NEFT CR Friends of Puri Trust #RO1",
    "NEFT CR Kumar and Sons hardware #RO1",
    "IMPS CR St. Mary's School #RO2",
    "NEFT DR Kalinga Rice supplies #RO1-FOOD", // a registered payee
    "Cheque deposit 004512 St Mary's School collection",
    "Fuel station Paradip card 4417",
    "ATM cash withdrawal field team Kendrapara",
    "BANK CHARGES monthly SERVICE CHARGE",
    "Monthly account maintenance SERVICE CHARGE",
    "SWIFT CHG inward remittance",
    "IMPS SERVICE CHARGE",
    "NEFT DR TRUCK HIRE #RO1-LOG",
    "NEFT DR Tarpaulins for camp 4",
    "UPI CR appeal #RO7",
  ]) {
    const a = anon(line);
    assert.equal(a.description, line);
    assert.deepEqual(a.found, []);
  }
});

test("names of individuals become an alias and the rest of the line stays", () => {
  const cases: [string, RegExp][] = [
    ["NEFT CR Kavya Menon donation #ASHA", /^NEFT CR Person-[0-9A-F]{6} donation #ASHA$/],
    ["UPI CR R. Das #ASHA-MED", /^UPI CR Person-[0-9A-F]{6} #ASHA-MED$/],
    ["UPI CR Meena S. donation #ASHA-FOOD", /^UPI CR Person-[0-9A-F]{6} donation #ASHA-FOOD$/],
    ["UPI CR Sanjay & family #RO2", /^UPI CR Person-[0-9A-F]{6} & family #RO2$/],
    ["NEFT CR JOHN SMITH DONATION #RO1", /^NEFT CR Person-[0-9A-F]{6} DONATION #RO1$/],
    ["UPI CR #RO1 Kavya Menon", /^UPI CR #RO1 Person-[0-9A-F]{6}$/],
    ["IMPS CR Dr. Mehta #RO2", /^IMPS CR Dr\. Person-[0-9A-F]{6} #RO2$/],
    ["Zelle payment from Maria Lopez", /^Zelle payment from Person-[0-9A-F]{6}$/],
    ["BY TRANSFER-NEFT*HDFC0000001*N123456789*RAJESH KUMAR-- #ASHA", /\*Person-[0-9A-F]{6}-- #ASHA$/],
  ];
  for (const [line, want] of cases) {
    const a = anon(line);
    assert.match(a.description, want);
    assert.deepEqual(a.found, ["NAME"]);
  }
  for (const name of ["Kavya", "Menon", "Das", "Meena", "Sanjay", "JOHN", "SMITH", "Mehta", "Maria", "Lopez", "RAJESH", "KUMAR"]) {
    for (const [line] of cases) assert.ok(!anon(line).description.includes(name), `${name} survived in "${line}"`);
  }
});

test("the same person always gets the same alias; another NGO or key gets a different one", () => {
  const alias = (s: string) => s.match(ALIAS)?.[0];
  const a = alias(anon("NEFT CR Kavya Menon donation #ASHA").description);
  assert.ok(a);
  assert.equal(alias(anon("IMPS CR KAVYA MENON gift").description), a);
  assert.equal(alias(anon("UPI CR whatever", "Kavya Menon").counterparty ?? ""), a);
  assert.notEqual(alias(anon("NEFT CR Kavya Nair donation").description), a);
  const line = { description: "NEFT CR Kavya Menon donation" };
  assert.notEqual(alias(anonymiseBankLine(line, { ...opts, scope: "ngo_b" }).description), a);
  assert.notEqual(alias(anonymiseBankLine(line, { ...opts, secret: "another" }).description), a);
});

test("a person in the payee column is replaced there and in the description", () => {
  const a = anon("UPI CR Sanjay & family #RO2", "Sanjay Patnaik");
  assert.match(a.counterparty ?? "", /^Person-[0-9A-F]{6}$/);
  assert.equal(a.description, `UPI CR ${a.counterparty} & family #RO2`);

  const b = anon("UPI CR Lakshmi N. #MONSOON", "Lakshmi N.");
  assert.equal(b.description, `UPI CR ${b.counterparty} #MONSOON`);
});

test("an organisation or a generic label in the payee column is kept", () => {
  assert.equal(anon("RTGS CR Kalinga Mills CSR grant #RO3", "Kalinga Mills Ltd").counterparty, "Kalinga Mills Ltd");
  assert.equal(anon("RTGS CR Kalinga Mills CSR grant #RO3", "Kalinga Mills Ltd").description, "RTGS CR Kalinga Mills CSR grant #RO3");
  assert.equal(anon("Fuel station Paradip card 4417", "Paradip Fuel Station").counterparty, "Paradip Fuel Station");
  assert.equal(anon("UPI CR anonymous donor #RO9", "UPI donor").counterparty, "UPI donor");
  // A bank feed's merchant name is a business even without a telling word.
  const merchant = anonymiseBankLine({ description: "Uber 072515 SF**POOL**", counterparty: "Uber" }, { ...opts, counterpartyIsMerchant: true });
  assert.deepEqual(merchant, { description: "Uber 072515 SF**POOL**", counterparty: "Uber", found: [] });
});

test("account numbers, phone numbers, emails and IDs are redacted", () => {
  assert.equal(anon("Refund a/c 00451288931, email arun.nair@example.org").description, "Refund a/c [ACCOUNT ••8931], email [EMAIL]");
  assert.equal(anon("Donation +91 98765 43210 #RO2").description, "Donation [PHONE] #RO2");
  assert.equal(anon("Call 555-123-4567 re invoice").description, "Call [PHONE] re invoice");
  assert.equal(anon("UPI/CR/123456789012/kavya@oksbi/Payment").description, "UPI/CR/[ACCOUNT ••9012]/[ACCOUNT]/Payment");
  assert.equal(anon("Card 4111 1111 1111 1111 and ID 1234 5678 9012").description, "Card [ACCOUNT ••1111] and ID [GOV_ID]");
  assert.deepEqual(anon("Refund a/c 00451288931, email arun.nair@example.org").found.sort(), ["ACCOUNT", "EMAIL"]);
  // Short numbers, invoice numbers and bank references aren't personal.
  for (const line of ["card 4417", "INV-443 tarpaulins", "Cheque deposit 004512", "ref UTR0019231", "SBIN0001234"]) assert.equal(anon(line).description, line);
});

test("tracking codes read the same before and after", () => {
  const fund = (id: string, codes: string[]) => ({ id, title: id, status: "active", trackingCodes: codes }) as unknown as Fund;
  const idx = new Map<string, Fund>();
  for (const f of [fund("f1", ["RO1", "ASHA"]), fund("f2", ["RO2", "MONSOON"])]) for (const c of f.trackingCodes ?? []) idx.set(c, f);
  for (const line of [
    "NEFT CR Kavya Menon donation #ASHA",
    "UPI CR R. Das #ASHA-MED",
    "UPI CR Lakshmi N. #monsoon-wat",
    "NEFT CR Lions Club #RO2 #RO1",
    "UPI CR #RO1 Kavya Menon 9876543210",
    "IMPS CR Anita Rao a/c 123456789 #RO9",
    "UPI kavya@oksbi #RO1",
  ]) {
    assert.deepEqual(matchCodes(anon(line).description, idx), matchCodes(line, idx), line);
  }
});

test("anonymising twice changes nothing more", () => {
  for (const [d, c] of [
    ["NEFT CR Kavya Menon donation #ASHA", undefined],
    ["UPI CR Sanjay & family #RO2", "Sanjay Patnaik"],
    ["Refund to Mr. Arun Nair a/c 00451288931, email arun.nair@example.org", undefined],
    ["UPI/CR/123456789012/JOHN SMITH/SBIN/johnsmith@oksbi/Payment #RO1", undefined],
  ] as [string, string | undefined][]) {
    const once = anon(d, c);
    const twice = anon(once.description, once.counterparty);
    assert.equal(twice.description, once.description);
    assert.equal(twice.counterparty, once.counterparty);
  }
});

test("imported lines are stored, posted and de-duplicated without the personal details", () => {
  const db = {
    ngos: [{ id: "ngo_a", name: "Test Relief", members: [] }],
    funds: [{ id: "fund_1", ngoId: "ngo_a", title: "Cyclone fund", status: "active", trackingCodes: ["RO1"], assignees: [] }],
    vendors: [],
    ledger: [],
    auditLog: [],
    bankAccounts: [],
    bankTxns: [],
    statementImports: [],
  } as unknown as DB;
  const account = { id: "bank_1", ngoId: "ngo_a", name: "Main account", provider: "csv", institution: "Test Bank", feePatterns: ["SERVICE CHARGE"] } as unknown as BankAccount;
  const rows: ParsedRow[] = [
    { date: "2026-11-01", amount: 50_000, description: "NEFT CR Kavya Menon donation #RO1" },
    { date: "2026-11-02", amount: -20_000, description: "NEFT DR Shelter Co tarpaulins #RO1-SHL", counterparty: "Shelter Co" },
    { date: "2026-11-03", amount: 7_500, description: "UPI CR Anita Rao 9876543210", counterparty: "Anita Rao" },
    { date: "2026-11-04", amount: -1_500, description: "Monthly SERVICE CHARGE" },
  ];
  const actor = { id: "m1", name: "Tester" };
  const first = ingestRows(db, account, rows, { source: "csv", actor });

  assert.equal(first.imp.imported, 4);
  assert.equal(first.imp.autoTagged, 2);
  assert.equal(first.imp.anonymised, 2);
  const [gift, tarps, untagged, fee] = db.bankTxns;
  assert.match(gift.description, /^NEFT CR Person-[0-9A-F]{6} donation #RO1$/);
  assert.deepEqual(gift.anonymised, ["NAME"]);
  assert.equal(tarps.description, "NEFT DR Shelter Co tarpaulins #RO1-SHL");
  assert.equal(tarps.counterparty, "Shelter Co");
  assert.equal(tarps.anonymised, undefined);
  assert.match(untagged.counterparty ?? "", /^Person-[0-9A-F]{6}$/);
  assert.equal(untagged.description, `UPI CR ${untagged.counterparty} [ACCOUNT ••3210]`);
  assert.equal(fee.isFee, true);
  assert.equal(fee.status, "fee_unallocated");

  // Nothing personal reaches the stored lines or the hash-chained ledger.
  const stored = JSON.stringify({ txns: db.bankTxns, ledger: db.ledger, imports: db.statementImports });
  for (const secret of ["Kavya", "Menon", "Anita", "Rao", "9876543210"]) assert.ok(!stored.includes(secret), `${secret} was stored`);
  assert.equal(db.ledger.length, 2);
  assert.deepEqual(codeIndex(db, "ngo_a").get("RO1")?.id, "fund_1");

  // The same statement again adds nothing: rows are still recognised by their original text.
  const again = ingestRows(db, account, rows, { source: "csv", actor });
  assert.equal(again.imp.imported, 0);
  assert.equal(again.imp.duplicates, 4);
  assert.equal(db.bankTxns.length, 4);
});
