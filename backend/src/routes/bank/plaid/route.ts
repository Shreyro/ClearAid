import { audit } from "@/lib/audit";
import { setHealth, syncAll } from "@/lib/bank-sync";
import { config } from "@/lib/config";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { publish } from "@/lib/events";
import { handle, json } from "@/lib/http";
import { createLinkToken, decryptToken, encryptToken, exchangePublicToken, getAccounts, plaidLive, updateItemWebhook, type PlaidAccount } from "@/lib/plaid";
import { actorOf, HttpError, requireNgo, requireNgoAdmin } from "@/lib/session";
import type { BankAccount, DB } from "@/lib/types";
import { accountView, findAccount } from "../shared";

type Body =
  | { action: "link_token"; accountId?: string }
  | { action: "exchange"; publicToken: string; institution?: string }
  | { action: "reconnected"; accountId: string }
  | { action: "sync_all" }
  | { action: "connect_simulated" };

const FEE_PATTERNS = ["SERVICE CHARGE", "WIRE FEE", "OVERDRAFT"];

/** Accounts money moves through: bank accounts (checking, savings…) and cards. Loans, mortgages and investments are left out. */
const useful = (a: PlaidAccount) => !a.type || a.type === "depository" || a.type === "credit";

/** One ClearAid account per Plaid account of a bank login, all sharing the login's token and cursor. */
function accountsFor(ngoId: string, by: string, institution: string, itemId: string, tokenEnc: string, accounts: PlaidAccount[], cursor?: string): BankAccount[] {
  return accounts.map((a) => ({
    id: newId("bank"),
    ngoId,
    name: `${institution} ${a.name}${a.mask ? ` ••${a.mask}` : ""}`.slice(0, 120),
    provider: "plaid",
    institution,
    mask: a.mask,
    currency: "USD",
    status: "active",
    createdAt: nowIso(),
    createdBy: by,
    feePatterns: FEE_PATTERNS,
    plaid: { itemId, accessTokenEnc: tokenEnc, accounts: [{ id: a.id, name: a.name, mask: a.mask }], accountId: a.id, cursor, health: { status: "ok", at: nowIso() }, ...(config.plaid.webhookUrl ? { webhookUrl: config.plaid.webhookUrl } : {}), simulated: false },
  }));
}

/** The connected accounts of one bank login, for an admin of this NGO. */
function itemAccounts(db: DB, ngoId: string, accountId: string) {
  const a = findAccount(db, ngoId, accountId);
  if (a.provider !== "plaid" || !a.plaid) throw new HttpError(400, "Only Plaid-connected accounts can be reconnected");
  if (a.plaid.simulated) throw new HttpError(400, "The simulated bank doesn't need reconnecting");
  return { first: a, all: db.bankAccounts.filter((x) => x.ngoId === ngoId && x.plaid?.itemId === a.plaid!.itemId) };
}

/**
 * Connecting banks through Plaid Link (admins), and syncing them:
 *   link_token  → the browser opens Plaid Link (with accountId: update mode, to log in again)
 *   exchange    → swap the public token for an access token (stored encrypted);
 *                 every account of that bank login is added
 *   reconnected → after update mode: mark the login healthy and add any new accounts
 *   sync_all    → pull new transactions from every connected bank (any staff)
 * Without Plaid keys, `connect_simulated` adds a demo bank feed instead.
 */
export const POST = handle(async (req: Request) => {
  const b = (await req.json()) as Body;

  if (b.action === "sync_all") {
    const me = await requireNgo();
    const results = await syncAll(actorOf(me), { ngoId: me.ngoId });
    if (!results.length) throw new HttpError(400, "No bank is connected yet");
    const imported = results.reduce((s, r) => s + r.imported, 0);
    const failed = results.filter((r) => r.error);
    return json({
      ok: true,
      results,
      imported,
      message: `${imported ? `${imported} new transactions` : "No new transactions"} from ${results.length - failed.length} of ${results.length} bank login${results.length === 1 ? "" : "s"}.${failed.length ? ` ${failed.map((f) => `${f.institution}: ${f.reconnect ? "needs reconnecting" : f.error}`).join("; ")}.` : ""}`,
    });
  }

  const admin = await requireNgoAdmin();

  if (b.action === "link_token") {
    if (!plaidLive()) throw new HttpError(400, "Plaid keys aren't configured. Use the simulated bank, or set PLAID_CLIENT_ID and PLAID_SECRET.");
    if (b.accountId) {
      const { first } = itemAccounts(getDb(), admin.ngoId, b.accountId);
      return json({ linkToken: await createLinkToken(admin.id, { accessToken: decryptToken(first.plaid!.accessTokenEnc) }), mode: "update", oauth: Boolean(config.plaid.redirectUri) });
    }
    return json({ linkToken: await createLinkToken(admin.id), mode: "new", oauth: Boolean(config.plaid.redirectUri) });
  }

  if (b.action === "reconnected") {
    if (!plaidLive()) throw new HttpError(400, "Plaid keys aren't configured");
    const { first, all } = itemAccounts(getDb(), admin.ngoId, b.accountId);
    const token = decryptToken(first.plaid!.accessTokenEnc);
    const fresh = await getAccounts(token);
    await updateItemWebhook(token).catch(() => undefined);
    const added = mutate((db) => {
      const known = new Set(all.map((a) => a.plaid!.accountId).filter(Boolean));
      const legacy = all.some((a) => !a.plaid!.accountId);
      // Accounts the person newly shared in update mode (an older connection already covers every account).
      const extra = legacy ? [] : accountsFor(admin.ngoId, admin.id, first.institution, first.plaid!.itemId, first.plaid!.accessTokenEnc, fresh.filter((a) => useful(a) && !known.has(a.id)), first.plaid!.cursor);
      db.bankAccounts.push(...extra);
      setHealth(db, first.plaid!.itemId, { status: "ok", at: nowIso() }, actorOf(admin));
      if (extra.length) audit(db, { actor: actorOf(admin), action: "bank.account_added", targetId: extra[0].id, summary: `Reconnected ${first.institution} and added ${extra.map((a) => a.name).join(", ")}` });
      return extra.length;
    });
    publish({ kind: "bank" });
    return json({ ok: true, added, message: `${first.institution} is connected again.${added ? ` ${added} more account${added === 1 ? "" : "s"} added.` : ""} Press Sync to catch up.` });
  }

  let accounts: BankAccount[];
  if (b.action === "exchange") {
    if (!plaidLive()) throw new HttpError(400, "Plaid keys aren't configured");
    if (!b.publicToken) throw new HttpError(400, "Missing public token");
    const x = await exchangePublicToken(b.publicToken);
    const institution = b.institution?.trim().slice(0, 80) || "Plaid-connected bank";
    if (getDb().bankAccounts.some((a) => a.plaid?.itemId === x.itemId)) throw new HttpError(409, `${institution} is already connected`);
    const kept = x.accounts.filter(useful);
    if (!kept.length) throw new HttpError(400, "That bank login shares no bank or card accounts (only loans or investments)");
    accounts = accountsFor(admin.ngoId, admin.id, institution, x.itemId, encryptToken(x.accessToken), kept);
  } else if (b.action === "connect_simulated") {
    accounts = [
      {
        id: newId("bank"),
        ngoId: admin.ngoId,
        name: "Coastal Co-operative Bank ••7710 (simulated)",
        provider: "plaid",
        institution: "Coastal Co-operative Bank (simulated)",
        mask: "7710",
        currency: "USD",
        status: "active",
        createdAt: nowIso(),
        createdBy: admin.id,
        feePatterns: ["SERVICE CHARGE", "SWIFT CHG"],
        plaid: { itemId: `sim_${newId("item")}`, accessTokenEnc: encryptToken("simulated"), accounts: [{ id: "sim_acc", name: "Relief operations current account", mask: "7710" }], health: { status: "ok", at: nowIso() }, simulated: true },
      },
    ];
  } else throw new HttpError(400, "Unknown action");

  mutate((db) => {
    db.bankAccounts.push(...accounts);
    const a = accounts[0];
    audit(db, {
      actor: actorOf(admin),
      action: "bank.account_added",
      targetId: a.id,
      summary: a.plaid!.simulated ? `Connected ${a.name} (simulated bank feed, demo mode)` : `Connected ${a.institution} via Plaid: ${accounts.map((x) => x.name).join(", ")}`,
      meta: { provider: "plaid", simulated: a.plaid!.simulated, accounts: accounts.length },
    });
  });
  publish({ kind: "bank" });
  const db = getDb();
  return json({ ok: true, account: accountView(db, accounts[0]), accounts: accounts.map((a) => accountView(db, a)) });
});
