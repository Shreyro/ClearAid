import { ingestRows, postAllocations, type ParsedRow } from "./banking";
import type { BankAccount, DB } from "./types";

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
