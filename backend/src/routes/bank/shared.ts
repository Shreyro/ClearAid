import { publish } from "@/lib/events";
import type { BankAccount, DB, LedgerEntry } from "@/lib/types";
import { HttpError } from "@/lib/session";
import { findPayPalAccount } from "@/lib/paypal-accounts";

/** Push new ledger lines to live views, then a generic "bank changed" ping. */
export function announce(entries: LedgerEntry[]) {
  for (const e of entries) publish({ kind: "ledger", fundId: e.fundId, entry: e });
  publish({ kind: "bank" });
}

export function findAccount(db: DB, ngoId: string, id: string): BankAccount {
  const a = db.bankAccounts.find((x) => x.id === id && x.ngoId === ngoId);
  if (!a) throw new HttpError(404, "Bank account not found");
  return a;
}

export function accountView(db: DB, a: BankAccount) {
  const txns = db.bankTxns.filter((t) => t.accountId === a.id);
  const imports = db.statementImports.filter((i) => i.accountId === a.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  const sum = (f: (t: (typeof txns)[number]) => boolean) => txns.filter(f).reduce((s, t) => s + t.amount, 0);
  return {
    id: a.id,
    name: a.name,
    provider: a.provider,
    institution: a.institution,
    mask: a.mask,
    status: a.status,
    createdAt: a.createdAt,
    lastSyncAt: a.lastSyncAt,
    feePatterns: a.feePatterns,
    csvMapping: a.csvMapping,
    simulated: a.plaid?.simulated ?? false,
    subAccounts: a.plaid?.accounts.map((s) => ({ name: s.name, mask: s.mask })) ?? [],
    /** Whether Plaid can still read this bank ("reconnect": an admin must log in to the bank again). */
    health: a.plaid?.health ?? null,
    /** PayPal accounts whose withdrawals land here (their deposits are transfers). */
    transfersFrom: (a.transfersFrom ?? []).map((id) => ({ id, name: findPayPalAccount(db, a.ngoId, id)?.name ?? id })),
    /** Other ClearAid accounts from the same bank login (they sync together). */
    sameLogin: a.plaid ? db.bankAccounts.filter((x) => x.id !== a.id && x.status === "active" && x.plaid?.itemId === a.plaid!.itemId).map((x) => x.name) : [],
    counts: {
      total: txns.length,
      untagged: txns.filter((t) => t.status === "untagged").length,
      fees: txns.filter((t) => t.status === "fee_unallocated").length,
      tagged: txns.filter((t) => t.status === "tagged" || t.status === "auto_tagged").length,
      transfers: txns.filter((t) => t.status === "transfer").length,
    },
    moneyIn: sum((t) => t.amount > 0),
    moneyOut: -sum((t) => t.amount < 0),
    imports: imports.slice(0, 8).map((i) => ({ id: i.id, source: i.source, fileName: i.fileName, rows: i.rows, imported: i.imported, duplicates: i.duplicates, autoTagged: i.autoTagged, anonymised: i.anonymised ?? 0, errors: i.errors.slice(0, 20), createdAt: i.createdAt, by: db.ngos.flatMap((n) => n.members).find((m) => m.id === i.createdBy)?.name ?? i.createdBy })),
  };
}
