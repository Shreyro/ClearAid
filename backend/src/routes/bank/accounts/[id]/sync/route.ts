import { audit } from "@/lib/audit";
import { ingestRows, type ParsedRow } from "@/lib/banking";
import { getDb, mutate, withLock } from "@/lib/db";
import { type Ctx, handle, json } from "@/lib/http";
import { decryptToken, simulatedSync, syncTransactions } from "@/lib/plaid";
import { actorOf, HttpError, requireNgo } from "@/lib/session";
import { accountView, announce, findAccount } from "../../../shared";

/** Pull new transactions from a Plaid-connected account (or the simulated bank). */
export const POST = handle(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const me = await requireNgo();
  const { id } = await ctx.params;
  return withLock(`bank:${id}`, async () => {
    const account = findAccount(getDb(), me.ngoId, id);
    if (account.provider !== "plaid" || !account.plaid) throw new HttpError(400, "Only connected (Plaid) accounts sync. Upload a CSV for this one.");
    if (account.status !== "active") throw new HttpError(400, "This account is disconnected");
    let rows: ParsedRow[];
    let cursor: string | undefined;
    let skipped = 0;
    if (account.plaid.simulated) ({ rows, cursor, skipped } = simulatedSync(account.plaid.cursor));
    else ({ rows, cursor, skipped } = await syncTransactions(decryptToken(account.plaid.accessTokenEnc), account.plaid.cursor));

    const res = mutate((db) => {
      const acc = findAccount(db, me.ngoId, id);
      acc.plaid!.cursor = cursor;
      const r = ingestRows(db, acc, rows, { source: "plaid_sync", actor: actorOf(me) });
      audit(db, {
        actor: actorOf(me),
        action: "bank.synced",
        targetId: r.imp.id,
        summary: `Synced ${acc.name}${acc.plaid!.simulated ? " (simulated bank)" : " via Plaid"}: ${r.imp.imported} new (${r.imp.autoTagged} tagged by code), ${r.imp.duplicates} already imported${skipped ? `, ${skipped} pending skipped` : ""}${r.imp.anonymised ? `. Personal details anonymised on ${r.imp.anonymised} line(s)` : ""}`,
        meta: { imported: r.imp.imported, autoTagged: r.imp.autoTagged, duplicates: r.imp.duplicates, anonymised: r.imp.anonymised ?? 0 },
      });
      return r;
    });
    announce(res.entries);
    const db = getDb();
    return json({
      ok: true,
      import: res.imp,
      account: accountView(db, findAccount(db, me.ngoId, id)),
      message: res.imp.imported
        ? `${res.imp.imported} new transactions (${res.imp.autoTagged} tagged by code).${res.imp.anonymised ? ` Personal details anonymised on ${res.imp.anonymised} line${res.imp.anonymised === 1 ? "" : "s"}.` : ""}`
        : "No new transactions since the last sync.",
    });
  });
});
