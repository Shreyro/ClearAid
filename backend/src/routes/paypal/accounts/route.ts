import { audit } from "@/lib/audit";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { publish } from "@/lib/events";
import { handle, json } from "@/lib/http";
import { checkCredentials, PayPalError } from "@/lib/paypal";
import { DEFAULT_PAYPAL, findPayPalAccount, fundAccount, paypalAccountsOf, paypalAccountView } from "@/lib/paypal-accounts";
import { encryptToken } from "@/lib/plaid";
import { actorOf, HttpError, requireNgo, requireNgoAdmin } from "@/lib/session";
import type { PayPalAccount } from "@/lib/types";

/** The NGO's PayPal accounts, with what each has collected and which funds pay into it. Secrets never leave the server. */
export const GET = handle(async () => {
  const me = await requireNgo();
  const db = getDb();
  return json({ accounts: paypalAccountsOf(db, me.ngoId).map((a) => paypalAccountView(db, a)) });
});

type Body =
  | { action: "create"; name?: string; email?: string; mode?: "live" | "simulated"; env?: "sandbox" | "live"; clientId?: string; clientSecret?: string; webhookId?: string }
  | { action: "update"; id: string; name?: string; email?: string; clientId?: string; clientSecret?: string; webhookId?: string }
  | { action: "disconnect" | "reconnect"; id: string }
  | { action: "assign_fund"; fundId: string; accountId: string };

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Ask PayPal for a token with these keys, so a typo is caught when the account is added rather than at a donor's checkout. */
async function verifyKeys(env: "sandbox" | "live", clientId: string, clientSecret: string) {
  try {
    await checkCredentials({ id: "check", name: "check", env, live: true, clientId, clientSecret, webhookId: "" });
  } catch (e) {
    throw new HttpError(400, `PayPal didn't accept those keys (${e instanceof PayPalError ? e.message : "couldn't reach PayPal"}). Check the client ID and secret come from the same ${env} app.`);
  }
}

/** Admins add, rename and disconnect PayPal accounts, and choose which account each fund's donation link pays into. */
export const POST = handle(async (req: Request) => {
  const admin = await requireNgoAdmin();
  const b = (await req.json()) as Body;
  const actor = actorOf(admin);

  if (b.action === "create") {
    const name = clean(b.name, 80);
    if (!name) throw new HttpError(400, 'Name the account, e.g. "Appeals account"');
    const mode = b.mode === "live" ? "live" : "simulated";
    const env = b.env === "live" ? "live" : "sandbox";
    const email = clean(b.email, 120) || undefined;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "That email doesn't look right");
    const clientId = clean(b.clientId, 200);
    const clientSecret = clean(b.clientSecret, 200);
    if (mode === "live") {
      if (!clientId || !clientSecret) throw new HttpError(400, "Paste the REST app's client ID and secret from developer.paypal.com");
      await verifyKeys(env, clientId, clientSecret);
    }
    const a = mutate((db) => {
      if (paypalAccountsOf(db, admin.ngoId).some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, `There is already an account called "${name}"`);
      if (mode === "live" && (db.paypalAccounts ?? []).some((x) => x.ngoId === admin.ngoId && x.clientId === clientId && x.env === env)) throw new HttpError(400, "That PayPal app is already connected");
      const acc: PayPalAccount = {
        id: newId("pp"),
        ngoId: admin.ngoId,
        name,
        email,
        env,
        mode,
        clientId: mode === "live" ? clientId : undefined,
        clientSecretEnc: mode === "live" ? encryptToken(clientSecret) : undefined,
        webhookId: clean(b.webhookId, 80) || undefined,
        status: "active",
        createdAt: nowIso(),
        createdBy: admin.id,
      };
      (db.paypalAccounts ??= []).push(acc);
      audit(db, { actor, action: "paypal.account_added", targetId: acc.id, summary: `Added PayPal account "${name}"${email ? ` (${email})` : ""}: ${mode === "live" ? `${env} keys checked with PayPal` : "simulated, moves no money"}`, meta: { mode, env } });
      return acc;
    });
    publish({ kind: "bank" });
    return json({ ok: true, account: paypalAccountView(getDb(), a) });
  }

  if (b.action === "assign_fund") {
    const out = mutate((db) => {
      const fund = db.funds.find((f) => f.id === b.fundId && f.ngoId === admin.ngoId);
      if (!fund) throw new HttpError(404, "Fund not found");
      if (fund.status === "closed") throw new HttpError(400, `${fund.title} is closed`);
      const to = findPayPalAccount(db, admin.ngoId, b.accountId);
      if (!to || to.status !== "active") throw new HttpError(400, "Choose an active PayPal account");
      const from = fundAccount(db, fund);
      if (from.id === to.id) return { fund, to };
      fund.paypalAccountId = to.id === DEFAULT_PAYPAL ? undefined : to.id;
      audit(db, { actor, action: "fund.paypal_account_changed", fundId: fund.id, targetId: fund.id, summary: `${fund.title}'s donation link now pays into "${to.name}" (was "${from.name}"). Gifts already made stay where they landed.` });
      return { fund, to };
    });
    publish({ kind: "fund", fundId: out.fund.id });
    return json({ ok: true, message: `New gifts to ${out.fund.title} go to "${out.to.name}".` });
  }

  // update / disconnect / reconnect: only accounts added here (the main one lives in the server's settings).
  if (b.action !== "update" && b.action !== "disconnect" && b.action !== "reconnect") throw new HttpError(400, "Unknown action");
  if (b.id === DEFAULT_PAYPAL) throw new HttpError(400, "The main account is set in the server's settings (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET)");
  const current = (getDb().paypalAccounts ?? []).find((x) => x.id === b.id && x.ngoId === admin.ngoId);
  if (!current) throw new HttpError(404, "PayPal account not found");

  if (b.action === "update") {
    const clientId = clean(b.clientId, 200);
    const clientSecret = clean(b.clientSecret, 200);
    if ((clientId || clientSecret) && current.mode !== "live") throw new HttpError(400, "A simulated account has no keys. Add a new live account instead.");
    if (clientId && !clientSecret) throw new HttpError(400, "Paste the secret that goes with the new client ID");
    if (clientSecret) await verifyKeys(current.env, clientId || current.clientId || "", clientSecret);
    const a = mutate((db) => {
      const acc = db.paypalAccounts!.find((x) => x.id === current.id)!;
      const changes: string[] = [];
      const name = clean(b.name, 80);
      if (name && name !== acc.name) {
        if (paypalAccountsOf(db, admin.ngoId).some((x) => x.id !== acc.id && x.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, `There is already an account called "${name}"`);
        changes.push(`renamed "${acc.name}" to "${name}"`);
        acc.name = name;
      }
      if (b.email !== undefined && (clean(b.email, 120) || undefined) !== acc.email) {
        acc.email = clean(b.email, 120) || undefined;
        changes.push("login email updated");
      }
      if (b.webhookId !== undefined && (clean(b.webhookId, 80) || undefined) !== acc.webhookId) {
        acc.webhookId = clean(b.webhookId, 80) || undefined;
        changes.push(acc.webhookId ? "webhook ID set" : "webhook ID removed");
      }
      if (clientSecret) {
        if (clientId) acc.clientId = clientId;
        acc.clientSecretEnc = encryptToken(clientSecret);
        changes.push("API keys replaced (checked with PayPal)");
      }
      if (!changes.length) throw new HttpError(400, "Nothing to change");
      audit(db, { actor, action: "paypal.account_updated", targetId: acc.id, summary: `Updated PayPal account ${acc.name}: ${changes.join("; ")}` });
      return acc;
    });
    publish({ kind: "bank" });
    return json({ ok: true, account: paypalAccountView(getDb(), a) });
  }

  const a = mutate((db) => {
    const acc = db.paypalAccounts!.find((x) => x.id === current.id)!;
    acc.status = b.action === "disconnect" ? "disconnected" : "active";
    const funds = db.funds.filter((f) => f.paypalAccountId === acc.id && f.status !== "closed").map((f) => f.title);
    audit(db, {
      actor,
      action: "paypal.account_disconnected",
      targetId: acc.id,
      summary:
        b.action === "disconnect"
          ? `Disconnected PayPal account ${acc.name}. Gifts already recorded are kept${funds.length ? `; new gifts to ${funds.join(", ")} go to the main account until it is reconnected` : ""}.`
          : `Reconnected PayPal account ${acc.name}${funds.length ? `; ${funds.join(", ")} pay into it again` : ""}.`,
    });
    return acc;
  });
  publish({ kind: "bank" });
  return json({ ok: true, account: paypalAccountView(getDb(), a) });
});
