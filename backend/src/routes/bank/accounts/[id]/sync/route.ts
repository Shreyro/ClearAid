import { syncItem } from "@/lib/bank-sync";
import { getDb } from "@/lib/db";
import { type Ctx, handle, json } from "@/lib/http";
import { actorOf, HttpError, requireNgo } from "@/lib/session";
import { accountView, findAccount } from "../../../shared";

/**
 * Pull new transactions for a connected account (or the simulated bank). The
 * whole bank login is synced, so its other accounts get their lines too.
 */
export const POST = handle(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const me = await requireNgo();
  const { id } = await ctx.params;
  const account = findAccount(getDb(), me.ngoId, id);
  if (account.provider !== "plaid" || !account.plaid) throw new HttpError(400, "Only connected (Plaid) accounts sync. Upload a CSV for this one.");
  if (account.status !== "active") throw new HttpError(400, "This account is disconnected");

  const r = await syncItem(account.plaid.itemId, actorOf(me), { ngoId: me.ngoId });
  if (!r) throw new HttpError(400, "This account is disconnected");
  if (r.error) throw new HttpError(r.reconnect ? 409 : 502, r.reconnect ? `${account.institution} needs you to log in again: press Reconnect. (${r.error})` : r.error);
  const db = getDb();
  const others = r.accounts > 1 ? ` across ${r.accounts} accounts at ${r.institution}` : "";
  return json({
    ok: true,
    import: { imported: r.imported, autoTagged: r.autoTagged, duplicates: r.duplicates, skipped: r.skipped },
    account: accountView(db, findAccount(db, me.ngoId, id)),
    message: r.imported ? `${r.imported} new transactions${others} (${r.autoTagged} tagged by code).` : `No new transactions since the last sync${others}.`,
  });
});
