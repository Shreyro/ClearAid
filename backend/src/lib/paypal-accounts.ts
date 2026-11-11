import { config } from "./config";
import { decryptToken } from "./plaid";
import type { PayPalConn } from "./paypal";
import type { DB, Fund, PayPalAccount } from "./types";

/**
 * An NGO can collect through several PayPal business accounts (say, one per
 * appeal or one per country office). Each fund's donation link pays into one
 * of them, and every later call about that money (capture, refund, webhook)
 * goes to the account it landed in.
 *
 * The account configured on the server (PAYPAL_CLIENT_ID/SECRET) is always
 * there as the default, simulated when no keys are set, so older data and
 * single-account setups keep working unchanged.
 */

export const DEFAULT_PAYPAL = "pp_default";

/** The server's own account, built from the environment (never stored). */
export function defaultAccount(ngoId: string): PayPalAccount {
  const live = Boolean(config.paypal.clientId && config.paypal.clientSecret);
  return {
    id: DEFAULT_PAYPAL,
    ngoId,
    name: live ? "Main PayPal account" : "Main PayPal account (simulated)",
    env: config.paypal.env,
    mode: live ? "live" : "simulated",
    clientId: live ? config.paypal.clientId : undefined,
    webhookId: config.paypal.webhookId || undefined,
    status: "active",
    createdAt: "",
    createdBy: "server",
  };
}

/** Every PayPal account of an NGO, the default first. */
export const paypalAccountsOf = (db: DB, ngoId: string): PayPalAccount[] => [defaultAccount(ngoId), ...(db.paypalAccounts ?? []).filter((a) => a.ngoId === ngoId)];

export function findPayPalAccount(db: DB, ngoId: string, id: string | undefined) {
  return paypalAccountsOf(db, ngoId).find((a) => a.id === (id || DEFAULT_PAYPAL));
}

/** Credentials for an account, ready for the PayPal client. Simulated (or broken) accounts come back with live: false. */
export function connOf(a: PayPalAccount): PayPalConn {
  if (a.id === DEFAULT_PAYPAL) {
    const live = a.mode === "live";
    return { id: a.id, name: a.name, env: config.paypal.env, live, clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, webhookId: config.paypal.webhookId };
  }
  let secret = "";
  try {
    secret = a.clientSecretEnc ? decryptToken(a.clientSecretEnc) : "";
  } catch {
    secret = ""; // SESSION_SECRET changed since it was saved: treat as not connected
  }
  const live = a.mode === "live" && Boolean(a.clientId && secret);
  return { id: a.id, name: a.name, env: a.env, live, clientId: a.clientId ?? "", clientSecret: secret, webhookId: a.webhookId ?? "" };
}

/** The account a fund's donations go to: its chosen account if still active, else the default. */
export function fundAccount(db: DB, fund: Fund): PayPalAccount {
  const chosen = fund.paypalAccountId ? findPayPalAccount(db, fund.ngoId, fund.paypalAccountId) : undefined;
  return chosen && chosen.status === "active" ? chosen : defaultAccount(fund.ngoId);
}

export const fundConn = (db: DB, fund: Fund) => connOf(fundAccount(db, fund));

/** The account a capture was made on (older captures: the default). */
export function captureConn(db: DB, capture: { id: string; accountId?: string }): PayPalConn {
  const donation = db.donations.find((d) => d.captureIds.includes(capture.id) && d.source === "paypal");
  const ngoId = db.funds.find((f) => f.id === donation?.fundId)?.ngoId ?? db.ngos[0]?.id ?? "";
  return connOf(findPayPalAccount(db, ngoId, capture.accountId) ?? defaultAccount(ngoId));
}

/** What the browser may see about an account: never the secret. */
export function paypalAccountView(db: DB, a: PayPalAccount) {
  const funds = db.funds.filter((f) => f.ngoId === a.ngoId && fundAccount(db, f).id === a.id);
  const ngoFunds = new Set(db.funds.filter((f) => f.ngoId === a.ngoId).map((f) => f.id));
  const ngoCaptures = new Set(db.donations.filter((d) => d.source === "paypal" && ngoFunds.has(d.fundId)).flatMap((d) => d.captureIds));
  const captures = db.captures.filter((c) => (c.accountId ?? DEFAULT_PAYPAL) === a.id && ngoCaptures.has(c.id));
  return {
    id: a.id,
    name: a.name,
    email: a.email,
    env: a.env,
    mode: a.mode,
    live: connOf(a).live,
    builtin: a.id === DEFAULT_PAYPAL,
    clientId: a.clientId ? `${a.clientId.slice(0, 6)}…${a.clientId.slice(-4)}` : null,
    webhooks: Boolean(a.webhookId),
    webhookUrl: `${config.appUrl.replace(/\/$/, "")}/api/paypal/webhook${a.id === DEFAULT_PAYPAL ? "" : `?account=${a.id}`}`,
    status: a.status,
    createdAt: a.createdAt || null,
    funds: funds.map((f) => ({ id: f.id, title: f.title, slug: f.slug })),
    received: captures.reduce((s, c) => s + c.amount, 0),
    refunded: captures.reduce((s, c) => s + c.refunded, 0),
    gifts: captures.length,
  };
}
