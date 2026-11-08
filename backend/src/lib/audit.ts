import { createHash } from "node:crypto";
import type { AuditAction, AuditEntry, DB } from "./types";

/**
 * Tamper-evident audit trail of every staff and system action (who did what,
 * when, to which fund). One hash chain across the whole NGO: each entry stores
 * the SHA-256 of the previous one, so editing or deleting any past entry breaks
 * every hash after it. Money movements also go on the per-fund ledger; this log
 * records the decisions and access around them.
 */

export const AUDIT_GENESIS = "0".repeat(64);
export const SYSTEM_ACTOR = { id: "system", name: "ClearAid system" };
export const AI_ACTOR = { id: "ai", name: "ClearAid AI fast lane" };

/** Must match canonicalAudit() in the frontend verifier byte for byte. */
export function canonicalAudit(e: Omit<AuditEntry, "hash">) {
  return [e.seq, e.ts, e.actorId, e.actorName, e.action, e.fundId ?? "", e.targetId ?? "", e.summary, e.meta ? JSON.stringify(e.meta) : "", e.prevHash].join("|");
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type AuditInput = {
  actor: { id: string; name: string };
  action: AuditAction;
  summary: string;
  fundId?: string;
  targetId?: string;
  meta?: Record<string, string | number | boolean>;
  ts?: string;
};

/** Append inside a `mutate` so the entry is saved with the change it describes. */
export function audit(db: DB, input: AuditInput): AuditEntry {
  const last = db.auditLog[db.auditLog.length - 1];
  const base: Omit<AuditEntry, "hash"> = {
    seq: last ? last.seq + 1 : 0,
    ts: input.ts ?? new Date().toISOString(),
    actorId: input.actor.id,
    actorName: input.actor.name,
    action: input.action,
    fundId: input.fundId,
    targetId: input.targetId,
    summary: input.summary.slice(0, 500),
    meta: input.meta,
    prevHash: last ? last.hash : AUDIT_GENESIS,
  };
  const full = { ...base, hash: sha256(canonicalAudit(base)) };
  db.auditLog.push(full);
  return full;
}

export function verifyAuditChain(entries: AuditEntry[]) {
  let prev = AUDIT_GENESIS;
  for (const [i, e] of entries.entries()) {
    const { hash, ...rest } = e;
    if (e.prevHash !== prev || e.seq !== i || sha256(canonicalAudit(rest)) !== hash) return { valid: false as const, brokenAt: e.seq, length: entries.length };
    prev = hash;
  }
  return { valid: true as const, head: prev, length: entries.length };
}
