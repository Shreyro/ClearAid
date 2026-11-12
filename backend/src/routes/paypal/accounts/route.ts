import { audit } from "@/lib/audit";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { publish } from "@/lib/events";
import { handle, json } from "@/lib/http";
import { config, paypalPartnerLive } from "@/lib/config";
import { checkCredentials, PayPalError } from "@/lib/paypal";
import { merchantForTracking, merchantStatus, referralLink } from "@/lib/paypal-partner";
import { paypalReconciliation } from "@/lib/transfers";
import { DEFAULT_PAYPAL, findPayPalAccount, fundAccount, paypalAccountsOf, paypalAccountView } from "@/lib/paypal-accounts";
import { encryptToken } from "@/lib/plaid";
import { actorOf, HttpError, requireNgo, requireNgoAdmin } from "@/lib/session";
import type { PayPalAccount } from "@/lib/types";

/** The NGO's PayPal accounts, with what each has collected and which funds pay into it. Secrets never leave the server. */
export const GET = handle(async () => {
  const me = await requireNgo();
  const db = getDb();
  // partner: NGOs can connect PayPal accounts by logging in to PayPal (ClearAid's partner app is set up).
  // reconciliation: what each account collected, what left it, what reached the linked bank, and what's still in PayPal.
  return json({
    accounts: paypalAccountsOf(db, me.ngoId).map((a) => ({ ...paypalAccountView(db, a), reconciliation: paypalReconciliation(db, me.ngoId, a.id) })),
    banks: db.bankAccounts.filter((b) => b.ngoId === me.ngoId && b.status === "active").map((b) => ({ id: b.id, name: b.name, transfersFrom: b.transfersFrom ?? [] })),
    partner: paypalPartnerLive(),
    env: config.paypal.env,
  });
});

type Body =
  | { action: "create"; name?: string; email?: string; mode?: "live" | "simulated"; env?: "sandbox" | "live"; clientId?: string; clientSecret?: string; webhookId?: string }
  | { action: "update"; id: string; name?: string; email?: string; clientId?: string; clientSecret?: string; webhookId?: string }
  | { action: "disconnect" | "reconnect"; id: string }
  | { action: "assign_fund"; fundId: string; accountId: string }
  /** Connect by logging in to PayPal: start (get the sign-up link), then finish (after PayPal sends the person back). */
  | { action: "connect_start"; name?: string; email?: string }
  | { action: "connect_finish"; id: string; merchantId?: string };

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

  if (b.action === "connect_start") {
    if (!paypalPartnerLive()) throw new HttpError(400, "Connecting by logging in to PayPal needs ClearAid's PayPal partner app (PAYPAL_PARTNER_CLIENT_ID, PAYPAL_PARTNER_CLIENT_SECRET and PAYPAL_PARTNER_MERCHANT_ID on the server). Add the account with its API keys instead.");
    const name = clean(b.name, 80);
    if (!name) throw new HttpError(400, 'Name the account, e.g. "Appeals account"');
    const email = clean(b.email, 120) || undefined;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "That email doesn't look right");
    const acc = mutate((db) => {
      if (paypalAccountsOf(db, admin.ngoId).some((x) => x.name.toLowerCase() === name.toLowerCase() && x.status !== "pending")) throw new HttpError(400, `There is already an account called "${name}"`);
      // A sign-up left unfinished under the same name is replaced.
      db.paypalAccounts = (db.paypalAccounts ?? []).filter((x) => !(x.ngoId === admin.ngoId && x.status === "pending" && x.name.toLowerCase() === name.toLowerCase()));
      const a: PayPalAccount = { id: newId("pp"), ngoId: admin.ngoId, name, email, env: config.paypal.env, mode: "partner", status: "pending", onboarding: { startedAt: nowIso() }, createdAt: nowIso(), createdBy: admin.id };
      db.paypalAccounts.push(a);
      return a;
    });
    try {
      // The tracking ID is the pending account's ID; PayPal sends it back as ?merchantId=, its own ID as ?merchantIdInPayPal=.
      const actionUrl = await referralLink({ trackingId: acc.id, returnUrl: `${config.appUrl.replace(/\/$/, "")}/paypal/connected`, email });
      return json({ ok: true, id: acc.id, actionUrl });
    } catch (e) {
      mutate((db) => {
        db.paypalAccounts = (db.paypalAccounts ?? []).filter((x) => x.id !== acc.id);
      });
      throw new HttpError(502, `PayPal couldn't start the sign-up: ${(e as Error).message}`);
    }
  }

  if (b.action === "connect_finish") {
    if (!paypalPartnerLive()) throw new HttpError(400, "ClearAid's PayPal partner app isn't configured");
    const acc0 = (getDb().paypalAccounts ?? []).find((x) => x.id === b.id && x.ngoId === admin.ngoId && x.mode === "partner");
    if (!acc0) throw new HttpError(404, "That PayPal sign-up wasn't found. Start again from Sources.");
    // What PayPal put on the return link is only a hint: ask PayPal which merchant finished this sign-up and what it granted.
    const merchantId = clean(b.merchantId, 40) || (await merchantForTracking(acc0.id).catch(() => null));
    if (!merchantId) throw new HttpError(400, "PayPal hasn't recorded a finished sign-up for this account yet. Finish it in the PayPal window, then try again.");
    let st;
    try {
      st = await merchantStatus(merchantId);
    } catch (e) {
      throw new HttpError(502, `PayPal couldn't confirm the connection: ${(e as Error).message}`);
    }
    if (st.trackingId && st.trackingId !== acc0.id) throw new HttpError(400, "That PayPal login belongs to a different sign-up");
    if (!st.granted) throw new HttpError(400, "ClearAid wasn't given permission on that PayPal account. Start again and agree to share access.");
    const out = mutate((db) => {
      if ((db.paypalAccounts ?? []).some((x) => x.id !== acc0.id && x.ngoId === admin.ngoId && x.mode === "partner" && x.merchantId === st.merchantId && x.status !== "disconnected")) {
        throw new HttpError(409, "That PayPal account is already connected");
      }
      const acc = db.paypalAccounts!.find((x) => x.id === acc0.id)!;
      const first = acc.status === "pending";
      acc.merchantId = st.merchantId;
      acc.email = st.email || acc.email;
      acc.status = "active";
      acc.onboarding = { ...(acc.onboarding ?? { startedAt: nowIso() }), finishedAt: nowIso(), paymentsReceivable: st.paymentsReceivable, emailConfirmed: st.emailConfirmed, permissions: st.permissions };
      if (first) {
        audit(db, {
          actor,
          action: "paypal.account_added",
          targetId: acc.id,
          summary: `Connected PayPal account "${acc.name}"${acc.email ? ` (${acc.email})` : ""} by logging in to PayPal: ClearAid may take payments and refund on its behalf${st.paymentsReceivable ? "" : " (PayPal says it can't receive payments yet)"}`,
          meta: { mode: "partner", env: acc.env },
        });
      }
      return acc;
    });
    publish({ kind: "bank" });
    const warn = [!st.paymentsReceivable && "PayPal says this account can't receive payments yet (it may need to finish setting up with PayPal)", !st.emailConfirmed && "its email address isn't confirmed with PayPal yet"].filter(Boolean);
    return json({ ok: true, account: paypalAccountView(getDb(), out), message: `"${out.name}" is connected${out.email ? ` (${out.email})` : ""}. Choose which funds pay into it under Settings → Funds.${warn.length ? ` Note: ${warn.join("; ")}.` : ""}` });
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
    if ((clientId || clientSecret) && current.mode === "partner") throw new HttpError(400, "This account is connected by logging in to PayPal; it has no keys to replace.");
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
    // An account connected by login that never finished signing up stays pending when reconnected.
    acc.status = b.action === "disconnect" ? "disconnected" : acc.mode === "partner" && !acc.merchantId ? "pending" : "active";
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
