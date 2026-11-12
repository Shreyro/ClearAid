import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { config } from "./config";
import type { ParsedRow } from "./banking";
import { sessionSecret } from "./session";

/**
 * Plaid (bank aggregation) over its REST API: Link token → public token
 * exchange → /transactions/sync with a cursor. Plaid's webhooks say when new
 * transactions are ready; a scheduled sync is the fallback (see bank-sync.ts).
 * Without PLAID_CLIENT_ID / PLAID_SECRET the app offers a simulated bank
 * instead, so the demo always works.
 */

export const plaidLive = () => Boolean(config.plaid.clientId && config.plaid.secret);
const base = () => (config.plaid.env === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com");

export class PlaidError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

/** Errors that mean the person has to log in to their bank again (Link in update mode). */
export const RECONNECT_CODES = new Set(["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "USER_PERMISSION_REVOKED", "ACCESS_NOT_GRANTED", "NO_ACCOUNTS"]);

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: config.plaid.clientId, secret: config.plaid.secret, ...body }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json().catch(() => ({}))) as { error_message?: string; error_code?: string; display_message?: string };
  if (!res.ok) throw new PlaidError(`Plaid: ${data.display_message || data.error_message || `request failed (${res.status})`}${data.error_code ? ` [${data.error_code}]` : ""}`, data.error_code);
  return data as T;
}

/**
 * A Link token. With `accessToken` it opens Link in update mode, to log in to
 * an already-connected bank again without losing its history.
 */
export async function createLinkToken(userId: string, opts: { accessToken?: string } = {}) {
  const P = config.plaid;
  const r = await call<{ link_token: string; expiration: string }>("/link/token/create", {
    client_name: "ClearAid",
    user: { client_user_id: userId },
    country_codes: P.countryCodes,
    language: "en",
    ...(opts.accessToken ? { access_token: opts.accessToken } : { products: ["transactions"], transactions: { days_requested: P.historyDays } }),
    ...(P.redirectUri ? { redirect_uri: P.redirectUri } : {}),
    ...(P.webhookUrl ? { webhook: P.webhookUrl } : {}),
  });
  return r.link_token;
}

export type PlaidAccount = { id: string; name: string; mask?: string; type?: string; subtype?: string };

export async function exchangePublicToken(publicToken: string) {
  const r = await call<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: publicToken });
  return { accessToken: r.access_token, itemId: r.item_id, accounts: await getAccounts(r.access_token) };
}

/** The accounts (checking, savings…) a bank login gives access to. */
export async function getAccounts(accessToken: string): Promise<PlaidAccount[]> {
  const acc = await call<{ accounts: { account_id: string; name: string; official_name?: string; mask?: string; type: string; subtype?: string | null }[] }>("/accounts/get", { access_token: accessToken });
  return acc.accounts.map((a) => ({ id: a.account_id, name: a.official_name || a.name, mask: a.mask ?? undefined, type: a.type, subtype: a.subtype ?? undefined }));
}

/** Point an existing connection at the current webhook URL (e.g. after moving to a new host). */
export async function updateItemWebhook(accessToken: string) {
  if (!config.plaid.webhookUrl) return;
  await call("/item/webhook/update", { access_token: accessToken, webhook: config.plaid.webhookUrl });
}

type PlaidTxn = {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  name: string;
  merchant_name?: string | null;
  pending: boolean;
  personal_finance_category?: { primary?: string } | null;
  iso_currency_code?: string | null;
};

/** A bank line plus the Plaid account it belongs to, so a multi-account login is split correctly. */
export type PlaidRow = ParsedRow & { plaidAccountId: string };

/**
 * Pull everything new since the cursor, across every account of the bank login.
 * The first sync returns the whole history asked for when it was connected.
 * Pending lines are skipped (they come back posted, with a new ID). If the
 * data changes while paging, Plaid asks to start again from the same cursor.
 */
export async function syncTransactions(accessToken: string, cursor: string | undefined) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await syncPages(accessToken, cursor);
    } catch (e) {
      if (!(e instanceof PlaidError) || e.code !== "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" || attempt >= 2) throw e;
    }
  }
}

async function syncPages(accessToken: string, cursor: string | undefined) {
  const rows: PlaidRow[] = [];
  let next = cursor;
  let skipped = 0;
  for (let page = 0; page < 100; page++) {
    const r = await call<{ added: PlaidTxn[]; modified: PlaidTxn[]; removed: { transaction_id: string }[]; next_cursor: string; has_more: boolean }>("/transactions/sync", {
      access_token: accessToken,
      cursor: next || undefined,
      count: 500,
    });
    for (const t of r.added) {
      if (t.pending || (t.iso_currency_code && t.iso_currency_code !== "USD")) {
        skipped++;
        continue;
      }
      rows.push({
        plaidAccountId: t.account_id,
        date: t.date,
        // Plaid reports money out as positive.
        amount: -Math.round(t.amount * 100),
        description: t.name,
        counterparty: t.merchant_name ?? undefined,
        // Plaid's merchant_name is an enriched business name; people only appear in the free-text `name`.
        counterpartyIsMerchant: Boolean(t.merchant_name),
        reference: t.transaction_id,
        typeCode: t.personal_finance_category?.primary === "BANK_FEES" ? "BANK_FEES" : undefined,
      });
    }
    next = r.next_cursor;
    if (!r.has_more) break;
  }
  return { rows, cursor: next, skipped };
}

// ------------------------------------------------------ Webhook checking ----

const webhookKeys = new Map<string, KeyObject>();

/**
 * Check a webhook really came from Plaid: the Plaid-Verification header is an
 * ES256 JWT signed with a key Plaid publishes, issued in the last 5 minutes,
 * carrying the SHA-256 of the exact body received.
 */
export async function verifyPlaidWebhook(rawBody: string, jwt: string | null, now = Date.now()) {
  if (!jwt || !plaidLive()) return false;
  try {
    const header = JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString("utf8")) as { alg?: string; kid?: string };
    if (header.alg !== "ES256" || !header.kid) return false;
    let key = webhookKeys.get(header.kid);
    if (!key) {
      const r = await call<{ key: { kty: string; crv: string; x: string; y: string; expired_at?: number | null } }>("/webhook_verification_key/get", { key_id: header.kid });
      if (r.key.expired_at) return false;
      key = createPublicKey({ key: { kty: r.key.kty, crv: r.key.crv, x: r.key.x, y: r.key.y }, format: "jwk" });
      webhookKeys.set(header.kid, key);
    }
    return checkWebhookJwt(rawBody, jwt, key, now);
  } catch {
    return false;
  }
}

/** The signature, age and body-hash checks on a Plaid webhook JWT, given Plaid's public key. */
export function checkWebhookJwt(rawBody: string, jwt: string, key: KeyObject, now = Date.now()) {
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return false;
  if (!verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))) return false;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as { iat?: number; request_body_sha256?: string };
  if (typeof claims.iat !== "number" || Math.abs(now / 1000 - claims.iat) > 5 * 60) return false;
  const want = Buffer.from(createHash("sha256").update(rawBody).digest("hex"));
  const got = Buffer.from(String(claims.request_body_sha256 ?? ""));
  return want.length === got.length && timingSafeEqual(want, got);
}

// ------------------------------------------------ Token encryption at rest ----

const key = () => createHash("sha256").update(`clearaid-bank-token|${sessionSecret()}`).digest();

export function encryptToken(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function decryptToken(sealed: string) {
  const [iv, tag, enc] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

// ------------------------------------------------------- Simulated bank ----

/**
 * A pretend bank feed for demos without Plaid keys. The first sync returns the
 * last two weeks; each later sync returns a couple of new lines until the
 * script runs out.
 */
const SIM: { daysAgo: number; amount: number; description: string; counterparty?: string; fee?: boolean }[] = [
  { daysAgo: 13, amount: 250000, description: "NEFT CR Rotary Club of Puri Cyclone appeal #RO1", counterparty: "Rotary Club of Puri" },
  { daysAgo: 12, amount: -48000, description: "Fuel station Paradip card 4417", counterparty: "Paradip Fuel Station" },
  { daysAgo: 11, amount: 75000, description: "IMPS CR Anita Rao donation #ASHA-FOOD", counterparty: "Anita Rao" },
  { daysAgo: 10, amount: -1500, description: "Monthly account maintenance SERVICE CHARGE", fee: true },
  { daysAgo: 9, amount: 120000, description: "RTGS CR Kalinga Mills CSR grant #RO3", counterparty: "Kalinga Mills Ltd" },
  { daysAgo: 8, amount: -320000, description: "NEFT DR Odisha Agro Traders rice 2t #RO1-FOOD", counterparty: "Odisha Agro Traders" },
  { daysAgo: 6, amount: 40000, description: "UPI CR Sanjay & family #RO2", counterparty: "Sanjay Patnaik" },
  { daysAgo: 5, amount: -2500, description: "SWIFT CHG inward remittance", fee: true },
  { daysAgo: 4, amount: 500000, description: "SWIFT CR Global Giving Circle Mahanadi #RO3 #RO1", counterparty: "Global Giving Circle" },
  { daysAgo: 2, amount: -90000, description: "NEFT DR Bluewave Logistics truck hire", counterparty: "Bluewave Logistics" },
  // Later syncs
  { daysAgo: 0, amount: 60000, description: "UPI CR Lakshmi N. #MONSOON", counterparty: "Lakshmi N." },
  { daysAgo: 0, amount: -45000, description: "NEFT DR Shelter Co tarpaulins INV-512 #ASHA-SHL", counterparty: "Shelter Co" },
  { daysAgo: 0, amount: 15000, description: "UPI CR anonymous donor #RO9", counterparty: "UPI donor" },
  { daysAgo: 0, amount: -1800, description: "IMPS SERVICE CHARGE", fee: true },
  { daysAgo: 0, amount: 200000, description: "NEFT CR Coastal Community Foundation grant #RO2", counterparty: "Coastal Community Foundation" },
];

export function simulatedSync(cursor: string | undefined) {
  const pos = Number(cursor ?? 0) || 0;
  const take = pos === 0 ? 10 : 2;
  const batch = SIM.slice(pos, pos + take);
  const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
  const rows: ParsedRow[] = batch.map((t, i) => ({
    date: day(t.daysAgo),
    amount: t.amount,
    description: t.description,
    counterparty: t.counterparty,
    reference: `SIM-${String(pos + i + 1).padStart(4, "0")}`,
    typeCode: t.fee ? "BANK_FEES" : undefined,
  }));
  return { rows, cursor: String(pos + batch.length), skipped: 0, exhausted: pos + batch.length >= SIM.length };
}
