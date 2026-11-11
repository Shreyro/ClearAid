import { ingestRows, postAllocations, type ParsedRow } from "./banking";
import type { BankAccount, DB, PayPalAccount } from "./types";

/**
 * Demo bank account with one CSV statement already imported: most lines carry
 * a tracking code and were tagged automatically, a few wait in the Untagged
 * queue (no code, an unknown code, codes for two funds), one bank fee is left
 * unallocated, and one fuel bill was tagged by hand with a reason.
 */
export function seedBank(db: DB, now: number) {
  const DAY = 86400_000;
  const day = (n: number) => new Date(now - n * DAY).toISOString().slice(0, 10);
  const at = new Date(now - 4 * DAY).toISOString();
  const account: BankAccount = {
    id: "bank_main",
    ngoId: "ngo_crc",
    name: "Main current account ••4821",
    provider: "csv",
    institution: "Coastal Co-operative Bank",
    mask: "4821",
    currency: "USD",
    status: "active",
    createdAt: new Date(now - 30 * DAY).toISOString(),
    createdBy: "adm_priya",
    feePatterns: ["SERVICE CHARGE", "SWIFT CHG", "WIRE FEE", "BANK CHARGES"],
    csvMapping: { date: "Date", description: "Narration", debit: "Withdrawal", credit: "Deposit", reference: "Ref No", dateFormat: "dmy" },
  };
  db.bankAccounts.push(account);

  const rows: ParsedRow[] = [
    { date: day(16), amount: 1_000_000, description: "RTGS CR Bayfront Foundation emergency grant #RO1", reference: "UTR0019231" },
    { date: day(15), amount: 50_000, description: "NEFT CR Kavya Menon donation #ASHA", reference: "UTR0019318" },
    { date: day(14), amount: -200_000, description: "NEFT DR Shelter Co tarpaulins INV-443 #RO1-SHL", reference: "UTR0019402" },
    { date: day(13), amount: 300_000, description: "IMPS CR Puri Traders Association #RO2", reference: "UTR0019477" },
    { date: day(12), amount: -48_000, description: "Fuel station Paradip card 4417", reference: "POS0019503" },
    { date: day(11), amount: 25_000, description: "UPI CR R. Das #ASHA-MED", reference: "UPI0019555" },
    { date: day(10), amount: -1_500, description: "BANK CHARGES monthly SERVICE CHARGE", reference: "CHG0019601" },
    { date: day(9), amount: 150_000, description: "NEFT CR Lions Club Cuttack flood appeal #RO2 #RO1", reference: "UTR0019688" },
    { date: day(8), amount: -95_000, description: "NEFT DR Medline Pharma clinic restock #ASHA-MED", reference: "UTR0019720" },
    { date: day(7), amount: 20_000, description: "UPI CR S. Kumar donation #RO9", reference: "UPI0019788" },
    { date: day(6), amount: -60_000, description: "NEFT DR Bluewave Logistics truck hire", reference: "UTR0019811" },
    { date: day(5), amount: 75_000, description: "Cheque deposit 004512 St Mary's School collection", reference: "CHQ004512" },
    { date: day(5), amount: 40_000, description: "IMPS CR Odisha Engineers Forum #MONSOON-WAT", reference: "UTR0019902" },
  ];
  ingestRows(db, account, rows, { source: "csv", fileName: "statement-oct-nov.csv", fileSha256: "seeded-statement-oct-nov", actor: { id: "adm_priya", name: "Priya Raman" }, at });

  // Daniel tagged the fuel bill by hand.
  const fuel = db.bankTxns.find((t) => t.description.startsWith("Fuel station"))!;
  fuel.allocations = [{ fundId: "fund_asha", amount: 48_000, category: "logistics", code: "RO1" }];
  fuel.status = "tagged";
  fuel.tagSource = "manual";
  fuel.untaggedReason = undefined;
  fuel.taggedBy = "adm_daniel";
  fuel.taggedByName = "Daniel Okafor";
  fuel.taggedAt = new Date(now - 3 * DAY).toISOString();
  fuel.reason = "Diesel for the Paradip distribution trucks (Cyclone Asha), receipt in the logistics folder";
  postAllocations(db, account, fuel, fuel.allocations, `tagged by Daniel Okafor: ${fuel.reason}`, fuel.taggedAt);
}

/**
 * A second bank account (the field office's), so the demo shows an NGO with
 * more than one account: cash collected at relief camps and paid in, and local
 * purchases paid from it. Returns false if it is already there.
 */
export function seedFieldAccount(db: DB, now: number) {
  if (db.bankAccounts.some((a) => a.id === "bank_field") || !db.ngos.some((n) => n.id === "ngo_crc")) return false;
  const DAY = 86400_000;
  const day = (n: number) => new Date(now - n * DAY).toISOString().slice(0, 10);
  const account: BankAccount = {
    id: "bank_field",
    ngoId: "ngo_crc",
    name: "Field office account ••7730",
    provider: "csv",
    institution: "Kendrapara District Co-operative Bank",
    mask: "7730",
    currency: "USD",
    status: "active",
    createdAt: new Date(now - 20 * DAY).toISOString(),
    createdBy: "adm_priya",
    feePatterns: ["SERVICE CHARGE", "SMS CHARGES", "CASH HANDLING"],
    csvMapping: { date: "Date", description: "Narration", debit: "Withdrawal", credit: "Deposit", reference: "Ref No", dateFormat: "dmy" },
  };
  db.bankAccounts.push(account);
  const rows: ParsedRow[] = [
    { date: day(9), amount: 38_000, description: "CASH DEP relief camp collection box Kendrapara #MONSOON", reference: "CSH0007711" },
    { date: day(8), amount: -21_500, description: "NEFT DR Maa Tarini General Store drinking water #MONSOON-WAT", reference: "UTR0007740" },
    { date: day(6), amount: 60_000, description: "NEFT CR Kendrapara Rotary Club #ASHA", reference: "UTR0007768" },
    { date: day(5), amount: -350, description: "SMS CHARGES quarterly", reference: "CHG0007790" },
    { date: day(4), amount: -18_000, description: "UPI DR local boat hire Pattamundai", reference: "UPI0007802" },
    { date: day(3), amount: -42_000, description: "NEFT DR Odisha Agro Traders rice #ASHA-FOOD", reference: "UTR0007815" },
  ];
  ingestRows(db, account, rows, { source: "csv", fileName: "field-office-nov.csv", fileSha256: "seeded-field-office-nov", actor: { id: "adm_priya", name: "Priya Raman" }, at: new Date(now - 2 * DAY).toISOString() });
  return true;
}

/**
 * A second PayPal account for the demo NGO: the Monsoon appeal collects into
 * its own "Appeals" account, so gifts to it are kept apart from the main one.
 * Simulated, so no keys are needed. Returns false if it is already there.
 */
export function seedPayPalAccounts(db: DB, now: number) {
  if (db.paypalAccounts?.some((a) => a.id === "pp_appeals") || !db.ngos.some((n) => n.id === "ngo_crc")) return false;
  const acc: PayPalAccount = {
    id: "pp_appeals",
    ngoId: "ngo_crc",
    name: "Appeals account (simulated)",
    email: "appeals@coastal-relief.example",
    env: "sandbox",
    mode: "simulated",
    status: "active",
    createdAt: new Date(now - 60 * 86400_000).toISOString(),
    createdBy: "adm_priya",
  };
  (db.paypalAccounts ??= []).push(acc);
  const monsoon = db.funds.find((f) => f.id === "fund_monsoon");
  if (monsoon) {
    monsoon.paypalAccountId = acc.id;
    // The appeal has always collected here: its PayPal gifts landed in this account.
    const caps = new Set(db.donations.filter((d) => d.fundId === monsoon.id && d.source === "paypal").flatMap((d) => d.captureIds));
    for (const c of db.captures) if (caps.has(c.id) && !c.id.startsWith("MANUAL-")) c.accountId = acc.id;
  }
  return true;
}
