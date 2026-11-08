import { createHash } from "node:crypto";
import type { DB, LedgerEntry, LedgerType } from "./types";

export const GENESIS = "0".repeat(64);

/**
 * Canonical string that is hashed for each entry. The browser re-computes this
 * exact string with WebCrypto to verify the chain independently, so keep it in
 * sync with `src/components/LedgerVerifier.tsx`.
 */
export function canonical(e: Omit<LedgerEntry, "hash">) {
  return [e.seq, e.fundId, e.ts, e.type, e.amount, e.memo, e.actor, e.ref ?? "", e.paypalRef ?? "", e.prevHash].join("|");
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function appendLedger(
  db: DB,
  entry: { fundId: string; type: LedgerType; amount: number; memo: string; actor: string; ref?: string; paypalRef?: string; ts?: string },
): LedgerEntry {
  const chain = db.ledger.filter((l) => l.fundId === entry.fundId);
  const last = chain[chain.length - 1];
  const base: Omit<LedgerEntry, "hash"> = {
    seq: last ? last.seq + 1 : 0,
    fundId: entry.fundId,
    ts: entry.ts ?? new Date().toISOString(),
    type: entry.type,
    amount: entry.amount,
    memo: entry.memo,
    actor: entry.actor,
    ref: entry.ref,
    paypalRef: entry.paypalRef,
    prevHash: last ? last.hash : GENESIS,
  };
  const full: LedgerEntry = { ...base, hash: sha256(canonical(base)) };
  db.ledger.push(full);
  return full;
}

export function verifyChain(entries: LedgerEntry[]) {
  let prev = GENESIS;
  for (const [i, e] of entries.entries()) {
    const { hash, ...rest } = e;
    if (e.prevHash !== prev || e.seq !== i || sha256(canonical(rest)) !== hash) {
      return { valid: false, brokenAt: e.seq };
    }
    prev = hash;
  }
  return { valid: true as const, head: prev, length: entries.length };
}
