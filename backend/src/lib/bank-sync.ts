import { audit, SYSTEM_ACTOR } from "./audit";
import { ingestRows, type ParsedRow } from "./banking";
import { config } from "./config";
import { getDb, mutate, nowIso, withLock } from "./db";
import { publish } from "./events";
import { decryptToken, PlaidError, plaidLive, RECONNECT_CODES, simulatedSync, syncTransactions, updateItemWebhook, type PlaidRow } from "./plaid";
import type { BankAccount, DB, LedgerEntry } from "./types";

/**
 * Pulling transactions from connected banks.
 *
 * Plaid works per bank login (an "item"), which can hold several accounts
 * (checking, savings…). ClearAid keeps one account per Plaid account, all
 * sharing the item's token and sync cursor, so a sync reads the item once and
 * hands each line to the account it belongs to.
 *
 * Syncs run when someone presses Sync, when Plaid's webhook says new
 * transactions are ready, and on a timer (PLAID_SYNC_MINUTES) as a fallback.
 */

type Actor = { id: string; name: string };
export type ItemSyncResult = { itemId: string; institution: string; imported: number; autoTagged: number; duplicates: number; skipped: number; accounts: number; error?: string; reconnect?: boolean };

/** Connected (Plaid or simulated) accounts, grouped by bank login. */
export function plaidItems(db: DB, ngoId?: string) {
  const items = new Map<string, BankAccount[]>();
  for (const a of db.bankAccounts) {
    if (a.provider !== "plaid" || !a.plaid || a.status !== "active" || (ngoId && a.ngoId !== ngoId)) continue;
    const list = items.get(a.plaid.itemId) ?? [];
    list.push(a);
    items.set(a.plaid.itemId, list);
  }
  return items;
}

/** Record whether Plaid can still read a bank login (shown on Sources; "reconnect" offers Link in update mode). */
export function setHealth(db: DB, itemId: string, health: NonNullable<BankAccount["plaid"]>["health"], actor: Actor = SYSTEM_ACTOR) {
  const accounts = db.bankAccounts.filter((a) => a.plaid?.itemId === itemId);
  const before = accounts[0]?.plaid?.health?.status ?? "ok";
  for (const a of accounts) a.plaid!.health = health;
  if (!accounts.length || before === health?.status) return;
  if (health?.status === "reconnect") {
    audit(db, { actor, action: "bank.reconnect_needed", targetId: accounts[0].id, summary: `${accounts[0].institution} needs to be reconnected: ${health.reason ?? "the bank login expired"}. Transactions stop arriving until an admin logs in to the bank again.` });
  } else if (health?.status === "ok" && before === "reconnect") {
    audit(db, { actor, action: "bank.reconnected", targetId: accounts[0].id, summary: `${accounts[0].institution} is reading transactions again` });
  }
}

/** Which of an item's lines go to which ClearAid account. Older connections (no accountId) take every line not claimed by another. */
export function splitByAccount(accounts: BankAccount[], rows: (ParsedRow | PlaidRow)[]) {
  const followed = new Set(accounts.map((a) => a.plaid!.accountId).filter(Boolean));
  return new Map(
    accounts.map((a) => [
      a.id,
      rows.filter((r) => {
        const id = (r as PlaidRow).plaidAccountId;
        return a.plaid!.accountId ? id === a.plaid!.accountId : !id || !followed.has(id);
      }),
    ]),
  );
}

/**
 * Sync one bank login. `quiet` (the timer and webhooks) writes nothing to the
 * audit log or import history when nothing new came in.
 */
export function syncItem(itemId: string, actor: Actor, opts: { quiet?: boolean; ngoId?: string } = {}): Promise<ItemSyncResult | null> {
  return withLock(`plaid:${itemId}`, async () => {
    const accounts = plaidItems(getDb(), opts.ngoId).get(itemId);
    if (!accounts?.length) return null;
    const first = accounts[0];
    const base = { itemId, institution: first.institution, imported: 0, autoTagged: 0, duplicates: 0, skipped: 0, accounts: accounts.length };

    let rows: (ParsedRow | PlaidRow)[];
    let cursor: string | undefined;
    let skipped = 0;
    try {
      if (first.plaid!.simulated) ({ rows, cursor, skipped } = simulatedSync(first.plaid!.cursor));
      else ({ rows, cursor, skipped } = await syncTransactions(decryptToken(first.plaid!.accessTokenEnc), first.plaid!.cursor));
    } catch (e) {
      const code = e instanceof PlaidError ? e.code : undefined;
      const reconnect = Boolean(code && RECONNECT_CODES.has(code));
      mutate((db) => setHealth(db, itemId, { status: reconnect ? "reconnect" : "error", reason: (e as Error).message.slice(0, 200), at: nowIso() }, actor));
      publish({ kind: "bank" });
      return { ...base, error: (e as Error).message, reconnect };
    }

    const parts = splitByAccount(accounts, rows);
    const out = mutate((db) => {
      const entries: LedgerEntry[] = [];
      const totals = { ...base, skipped };
      for (const a of accounts) {
        const acc = db.bankAccounts.find((x) => x.id === a.id)!;
        acc.plaid!.cursor = cursor;
        const mine = parts.get(a.id) ?? [];
        if (!mine.length && opts.quiet) {
          acc.lastSyncAt = nowIso();
          continue;
        }
        const r = ingestRows(db, acc, mine, { source: "plaid_sync", actor });
        entries.push(...r.entries);
        totals.imported += r.imp.imported;
        totals.autoTagged += r.imp.autoTagged;
        totals.duplicates += r.imp.duplicates;
        if (r.imp.imported || !opts.quiet) {
          audit(db, {
            actor,
            action: "bank.synced",
            targetId: r.imp.id,
            summary: `Synced ${acc.name}${acc.plaid!.simulated ? " (simulated bank)" : " via Plaid"}: ${r.imp.imported} new (${r.imp.autoTagged} tagged by code), ${r.imp.duplicates} already imported${skipped ? `, ${skipped} pending skipped` : ""}${r.imp.anonymised ? `. Personal details anonymised on ${r.imp.anonymised} line(s)` : ""}`,
            meta: { imported: r.imp.imported, autoTagged: r.imp.autoTagged, duplicates: r.imp.duplicates, anonymised: r.imp.anonymised ?? 0 },
          });
        }
      }
      setHealth(db, itemId, { status: "ok", at: nowIso() }, actor);
      return { totals, entries };
    });
    for (const e of out.entries) publish({ kind: "ledger", fundId: e.fundId, entry: e });
    publish({ kind: "bank" });
    return out.totals;
  });
}

/** Sync every connected bank login, one after another (of one NGO, or all of them). */
export async function syncAll(actor: Actor, opts: { ngoId?: string; quiet?: boolean; liveOnly?: boolean } = {}) {
  const results: ItemSyncResult[] = [];
  for (const [itemId, accounts] of plaidItems(getDb(), opts.ngoId)) {
    if (opts.liveOnly && accounts[0].plaid!.simulated) continue;
    const r = await syncItem(itemId, actor, { quiet: opts.quiet, ngoId: opts.ngoId });
    if (r) results.push(r);
  }
  return results;
}

/**
 * When the public address changes (a new tunnel, a new host), tell Plaid where
 * to send each connected bank's webhooks from now on.
 */
export async function refreshWebhooks() {
  const url = config.plaid.webhookUrl;
  if (!url || !plaidLive()) return 0;
  let updated = 0;
  for (const [itemId, accounts] of plaidItems(getDb())) {
    const a = accounts[0];
    if (a.plaid!.simulated || a.plaid!.webhookUrl === url) continue;
    try {
      await updateItemWebhook(decryptToken(a.plaid!.accessTokenEnc));
      mutate((db) => {
        for (const x of db.bankAccounts) if (x.plaid?.itemId === itemId) x.plaid.webhookUrl = url;
      });
      updated++;
    } catch (e) {
      console.error(`[clearaid] couldn't update the Plaid webhook for ${a.institution}`, (e as Error).message);
    }
  }
  if (updated) console.log(`[clearaid] Plaid: ${updated} bank login(s) now send webhooks to ${url}`);
  return updated;
}

/** The fallback timer: sync every real (non-simulated) bank login every PLAID_SYNC_MINUTES. */
let timer: NodeJS.Timeout | undefined;
export function startAutoSync() {
  void refreshWebhooks().catch(() => undefined);
  if (timer || !config.plaid.syncMinutes || !plaidLive()) return;
  const run = () => void syncAll(SYSTEM_ACTOR, { quiet: true, liveOnly: true }).catch((e) => console.error("[clearaid] scheduled bank sync failed", e));
  timer = setInterval(run, config.plaid.syncMinutes * 60_000);
  timer.unref?.();
  setTimeout(run, 30_000).unref?.();
  console.log(`[clearaid] Plaid: syncing connected banks every ${config.plaid.syncMinutes} min${config.plaid.webhookUrl ? " and on Plaid's webhooks" : ""}`);
}
