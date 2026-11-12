import type { DB, EntryMeta, LedgerEntry, TxnTag } from "./types";

/**
 * Things staff add to a transaction after it happened, without touching the
 * ledger (its entries are hash-chained and never change):
 *
 *  - documents: invoices, receipts or other files attached later
 *  - tags: the NGO's own category tags (e.g. "Boat hire", "Volunteer meals"),
 *    any number per transaction, created by staff
 *
 * Both are keyed by the ledger entry ("<fundId>:<seq>"), are staff-only (never
 * shown to donor logins or on embeds) and every change is audit-logged.
 */

export const entryKey = (e: Pick<LedgerEntry, "fundId" | "seq">) => `${e.fundId}:${e.seq}`;
export const tagsOf = (db: DB) => (db.txnTags ??= []);
export const metaOf = (db: DB) => (db.entryMeta ??= {});

/** Tag colours staff pick from (they render on light and dark themes). */
export const TAG_COLORS = ["teal", "indigo", "amber", "rose", "sky", "lime", "violet", "slate"] as const;

export function entryByKey(db: DB, key: string): LedgerEntry | undefined {
  const i = key.lastIndexOf(":");
  if (i < 1) return undefined;
  const fundId = key.slice(0, i);
  const seq = Number(key.slice(i + 1));
  return db.ledger.find((e) => e.fundId === fundId && e.seq === seq);
}

/** Every file that already backs something (so one invoice isn't used twice). */
export function fileInUse(db: DB, fileId: string) {
  if ((db.payments ?? []).some((p) => p.receipt?.fileId === fileId && p.status !== "void")) return "a recorded payment";
  if (db.bankTxns.some((t) => t.receipts?.some((r) => r.fileId === fileId))) return "a bank line";
  if (Object.values(metaOf(db)).some((m) => m.docs?.some((d) => d.fileId === fileId))) return "another transaction";
  return null;
}

/**
 * Whether money out has its paperwork, from wherever it was attached: a
 * declared payment's receipt, a bank line's receipts, a payment request's
 * receipts, or documents added to the transaction afterwards.
 */
export function hasDocument(db: DB, e: LedgerEntry, meta?: EntryMeta) {
  if (meta?.docs?.length) return true;
  if (e.type === "expense") return Boolean((db.payments ?? []).find((p) => p.id === e.ref)?.receipt);
  if (e.type === "bank_out" || e.type === "bank_in") return Boolean(db.bankTxns.find((t) => t.id === e.ref)?.receipts?.length);
  if (e.type === "withdrawal") return Boolean(db.withdrawals.find((w) => w.id === e.ref)?.receiptFileIds.length);
  return false;
}

/** Tags and documents of one transaction, for staff. */
export function metaView(db: DB, key: string) {
  const m = metaOf(db)[key];
  const tags = tagsOf(db);
  return {
    tags: (m?.tagIds ?? []).map((id) => tags.find((t) => t.id === id)).filter((t): t is TxnTag => Boolean(t)).map((t) => ({ id: t.id, name: t.name, color: t.color })),
    docs: (m?.docs ?? []).map((d) => ({ fileId: d.fileId, kind: d.kind, name: db.files.find((f) => f.id === d.fileId)?.name ?? "document", url: `/api/files/${d.fileId}`, byId: d.byId, byName: d.byName, at: d.at })),
  };
}
