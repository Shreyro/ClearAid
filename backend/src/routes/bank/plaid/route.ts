import { audit } from "@/lib/audit";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { publish } from "@/lib/events";
import { handle, json } from "@/lib/http";
import { createLinkToken, encryptToken, exchangePublicToken, plaidLive } from "@/lib/plaid";
import { actorOf, HttpError, requireNgoAdmin } from "@/lib/session";
import type { BankAccount } from "@/lib/types";
import { accountView } from "../shared";

type Body = { action: "link_token" } | { action: "exchange"; publicToken: string; institution?: string } | { action: "connect_simulated" };

/**
 * Connect a bank through Plaid Link (admins only):
 *   1. link_token → the browser opens Plaid Link
 *   2. exchange   → swap the public token for an access token, stored encrypted
 * Without Plaid keys, `connect_simulated` adds a demo bank feed instead.
 */
export const POST = handle(async (req: Request) => {
  const admin = await requireNgoAdmin();
  const b = (await req.json()) as Body;
  if (b.action === "link_token") {
    if (!plaidLive()) throw new HttpError(400, "Plaid keys aren't configured. Use the simulated bank, or set PLAID_CLIENT_ID and PLAID_SECRET.");
    return json({ linkToken: await createLinkToken(admin.id) });
  }

  let account: BankAccount;
  if (b.action === "exchange") {
    if (!plaidLive()) throw new HttpError(400, "Plaid keys aren't configured");
    if (!b.publicToken) throw new HttpError(400, "Missing public token");
    const x = await exchangePublicToken(b.publicToken);
    const institution = b.institution?.trim().slice(0, 80) || "Plaid-connected bank";
    account = {
      id: newId("bank"),
      ngoId: admin.ngoId,
      name: `${institution}${x.accounts[0]?.mask ? ` ••${x.accounts[0].mask}` : ""}`,
      provider: "plaid",
      institution,
      mask: x.accounts[0]?.mask,
      currency: "USD",
      status: "active",
      createdAt: nowIso(),
      createdBy: admin.id,
      feePatterns: ["SERVICE CHARGE", "WIRE FEE", "OVERDRAFT"],
      plaid: { itemId: x.itemId, accessTokenEnc: encryptToken(x.accessToken), accounts: x.accounts, simulated: false },
    };
  } else if (b.action === "connect_simulated") {
    account = {
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
      plaid: { itemId: `sim_${newId("item")}`, accessTokenEnc: encryptToken("simulated"), accounts: [{ id: "sim_acc", name: "Relief operations current account", mask: "7710" }], simulated: true },
    };
  } else throw new HttpError(400, "Unknown action");

  mutate((db) => {
    db.bankAccounts.push(account);
    audit(db, {
      actor: actorOf(admin),
      action: "bank.account_added",
      targetId: account.id,
      summary: `Connected ${account.name} ${account.plaid!.simulated ? "(simulated bank feed, demo mode)" : "via Plaid"}${account.plaid!.accounts.length > 1 ? ` with ${account.plaid!.accounts.length} accounts` : ""}`,
      meta: { provider: "plaid", simulated: account.plaid!.simulated },
    });
  });
  publish({ kind: "bank" });
  return json({ ok: true, account: accountView(getDb(), account) });
});
