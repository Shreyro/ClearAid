import { SYSTEM_ACTOR } from "@/lib/audit";
import { setHealth, syncItem } from "@/lib/bank-sync";
import { getDb, mutate, nowIso } from "@/lib/db";
import { publish } from "@/lib/events";
import { handle, json } from "@/lib/http";
import { RECONNECT_CODES, verifyPlaidWebhook } from "@/lib/plaid";

type Hook = { webhook_type?: string; webhook_code?: string; item_id?: string; error?: { error_code?: string; error_message?: string } | null };

/** Transactions webhooks that mean "there is something new to pull". */
const SYNC_CODES = new Set(["SYNC_UPDATES_AVAILABLE", "INITIAL_UPDATE", "HISTORICAL_UPDATE", "DEFAULT_UPDATE", "TRANSACTIONS_REMOVED"]);
/** Item webhooks that mean the bank login has to be renewed. */
const ITEM_RECONNECT: Record<string, string> = {
  PENDING_EXPIRATION: "the bank's consent expires soon",
  PENDING_DISCONNECT: "the bank will disconnect soon",
  USER_PERMISSION_REVOKED: "access was revoked at the bank",
  NEW_ACCOUNTS_AVAILABLE: "the bank has new accounts; reconnect to choose which to share",
};

/**
 * Plaid tells ClearAid when new transactions are ready and when a bank login
 * needs attention. Only webhooks signed by Plaid are acted on. Plaid wants a
 * quick answer, so syncing happens after the reply.
 */
export const POST = handle(async (req: Request) => {
  const raw = await req.text();
  if (!(await verifyPlaidWebhook(raw, req.headers.get("plaid-verification")))) return json({ error: "Signature verification failed or Plaid isn't configured" }, 401);
  let hook: Hook;
  try {
    hook = JSON.parse(raw) as Hook;
  } catch {
    return json({ error: "Not JSON" }, 400);
  }
  const itemId = hook.item_id ?? "";
  if (!itemId || !getDb().bankAccounts.some((a) => a.plaid?.itemId === itemId)) return json({ ok: true, ignored: "unknown item" });

  if (hook.webhook_type === "TRANSACTIONS" && SYNC_CODES.has(hook.webhook_code ?? "")) {
    void syncItem(itemId, SYSTEM_ACTOR, { quiet: true }).catch((e) => console.error("[clearaid] Plaid webhook sync failed", e));
    return json({ ok: true, syncing: true });
  }

  if (hook.webhook_type === "ITEM") {
    const code = hook.webhook_code ?? "";
    const errorCode = hook.error?.error_code ?? "";
    if (code === "LOGIN_REPAIRED") mutate((db) => setHealth(db, itemId, { status: "ok", at: nowIso() }));
    else if (code === "ERROR" && RECONNECT_CODES.has(errorCode)) mutate((db) => setHealth(db, itemId, { status: "reconnect", reason: hook.error?.error_message || errorCode, at: nowIso() }));
    else if (code === "ERROR") mutate((db) => setHealth(db, itemId, { status: "error", reason: hook.error?.error_message || errorCode || "Plaid reported an error", at: nowIso() }));
    else if (ITEM_RECONNECT[code]) mutate((db) => setHealth(db, itemId, { status: "reconnect", reason: ITEM_RECONNECT[code], at: nowIso() }));
    publish({ kind: "bank" });
  }
  return json({ ok: true });
});
