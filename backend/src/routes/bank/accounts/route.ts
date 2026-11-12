import { audit } from "@/lib/audit";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { publish } from "@/lib/events";
import { handle, json } from "@/lib/http";
import { config } from "@/lib/config";
import { plaidLive } from "@/lib/plaid";
import { findPayPalAccount } from "@/lib/paypal-accounts";
import { rescanTransfers } from "@/lib/transfers";
import { actorOf, HttpError, requireNgo, requireNgoAdmin } from "@/lib/session";
import type { BankAccount } from "@/lib/types";
import { accountView, findAccount } from "../shared";

/** Bank accounts of the NGO (every staff member can see them and upload statements). */
export const GET = handle(async () => {
  const me = await requireNgo();
  const db = getDb();
  return json({
    accounts: db.bankAccounts.filter((a) => a.ngoId === me.ngoId).map((a) => accountView(db, a)),
    plaid: { live: plaidLive(), env: config.plaid.env, oauth: Boolean(config.plaid.redirectUri), webhooks: Boolean(config.plaid.webhookUrl), autoSyncMinutes: plaidLive() ? config.plaid.syncMinutes : 0 },
  });
});

type Body =
  | { action: "create_csv"; name?: string; institution?: string; mask?: string }
  /** transfersFrom: the PayPal accounts that withdraw into this bank account (their deposits are transfers). */
  | { action: "update"; id: string; name?: string; feePatterns?: string[]; transfersFrom?: string[] }
  | { action: "disconnect"; id: string }
  | { action: "reconnect"; id: string };

/** Admins add CSV accounts, rename, set fee patterns, or disconnect. (Plaid connections: /api/bank/plaid.) */
export const POST = handle(async (req: Request) => {
  const admin = await requireNgoAdmin();
  const b = (await req.json()) as Body;
  let linked: { names: string[]; marked: number } | undefined;
  const out = mutate((db) => {
    if (b.action === "create_csv") {
      const name = b.name?.trim().slice(0, 80);
      if (!name) throw new HttpError(400, "Name the account, e.g. \"Main current account\"");
      const mask = b.mask?.replace(/\D/g, "").slice(-4) || undefined;
      const a: BankAccount = {
        id: newId("bank"),
        ngoId: admin.ngoId,
        name,
        provider: "csv",
        institution: b.institution?.trim().slice(0, 80) || "Bank (CSV upload)",
        mask,
        currency: "USD",
        status: "active",
        createdAt: nowIso(),
        createdBy: admin.id,
        feePatterns: ["SERVICE CHARGE", "SWIFT CHG", "WIRE FEE", "BANK CHARGES"],
      };
      db.bankAccounts.push(a);
      audit(db, { actor: actorOf(admin), action: "bank.account_added", targetId: a.id, summary: `Added bank account "${a.name}"${mask ? ` ••${mask}` : ""} (${a.institution}) for CSV statement uploads`, meta: { provider: "csv" } });
      return a;
    }
    const a = findAccount(db, admin.ngoId, b.id);
    if (b.action === "update") {
      const changes: string[] = [];
      if (b.name?.trim() && b.name.trim() !== a.name) {
        changes.push(`renamed "${a.name}" to "${b.name.trim().slice(0, 80)}"`);
        a.name = b.name.trim().slice(0, 80);
      }
      if (Array.isArray(b.feePatterns)) {
        const pats = [...new Set(b.feePatterns.map((p) => String(p).trim().toUpperCase().slice(0, 40)).filter(Boolean))].slice(0, 20);
        changes.push(`fee patterns: ${pats.join(", ") || "none"}`);
        a.feePatterns = pats;
      }
      if (Array.isArray(b.transfersFrom)) {
        const ids = [...new Set(b.transfersFrom.map(String))];
        for (const id of ids) if (!findPayPalAccount(db, admin.ngoId, id)) throw new HttpError(400, "Choose your own PayPal accounts");
        const before = a.transfersFrom ?? [];
        if (ids.join() !== before.join()) {
          a.transfersFrom = ids;
          const names = ids.map((id) => findPayPalAccount(db, admin.ngoId, id)!.name);
          const marked = rescanTransfers(db, a);
          audit(db, { actor: actorOf(admin), action: "bank.paypal_link_changed", targetId: a.id, summary: `${a.name} receives withdrawals from ${names.length ? names.map((n) => `"${n}"`).join(", ") : "no PayPal account"}${marked ? `; ${marked} waiting deposit(s) recognised as transfers` : ""}` });
          linked = { names, marked };
        }
      }
      if (!changes.length && !linked) throw new HttpError(400, "Nothing to change");
      if (changes.length) audit(db, { actor: actorOf(admin), action: "bank.account_updated", targetId: a.id, summary: `Updated bank account ${a.name}: ${changes.join("; ")}` });
      return a;
    }
    if (b.action === "disconnect" || b.action === "reconnect") {
      a.status = b.action === "disconnect" ? "disconnected" : "active";
      audit(db, { actor: actorOf(admin), action: "bank.account_disconnected", targetId: a.id, summary: `${b.action === "disconnect" ? "Disconnected" : "Reconnected"} bank account ${a.name}. Transactions already imported are kept.` });
      return a;
    }
    throw new HttpError(400, "Unknown action");
  });
  publish({ kind: "bank" });
  const message = linked
    ? `${out.name} ${linked.names.length ? `receives withdrawals from ${linked.names.join(", ")}. Their deposits count as transfers, never as new money on a fund.` : "no longer receives PayPal withdrawals."}${linked.marked ? ` ${linked.marked} waiting deposit${linked.marked === 1 ? " was" : "s were"} recognised as transfers.` : ""}`
    : undefined;
  return json({ ok: true, account: accountView(getDb(), out), ...(message ? { message } : {}) });
});
