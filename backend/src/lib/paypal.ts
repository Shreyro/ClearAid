import { randomBytes, randomUUID } from "node:crypto";
import { toValue } from "./money";

/**
 * Thin PayPal REST client (Orders v2, Payments v2 refunds, Payouts v1,
 * webhook verification). Every call names the PayPal account it acts on, so an
 * NGO can run several (see paypal-accounts.ts). A simulated account moves no
 * money: its IDs are prefixed with "SIM-" and the UI labels them as such.
 */

/** One PayPal account's credentials, resolved server-side. */
export type PayPalConn = {
  id: string;
  name: string;
  env: "sandbox" | "live";
  live: boolean;
  clientId: string;
  clientSecret: string;
  webhookId: string;
};

export const paypalBase = (env: PayPalConn["env"]) => (env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");

export class PayPalError extends Error {
  constructor(message: string, public status: number, public details?: unknown) {
    super(message);
  }
}

const tokens = new Map<string, { token: string; exp: number }>();

async function accessToken(c: PayPalConn): Promise<string> {
  const cacheKey = `${c.env}|${c.clientId}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const auth = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64");
  const res = await fetch(`${paypalBase(c.env)}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) throw new PayPalError(json.error_description || "PayPal auth failed", res.status, json);
  tokens.set(cacheKey, { token: json.access_token, exp: Date.now() + (json.expires_in ?? 3000) * 1000 });
  return json.access_token;
}

/** Check a client ID and secret by asking PayPal for a token; throws PayPalError if they're wrong. */
export async function checkCredentials(c: PayPalConn) {
  await accessToken(c);
}

async function api<T>(c: PayPalConn, path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const token = await accessToken(c);
  const res = await fetch(`${paypalBase(c.env)}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.method && init.method !== "GET" ? { "PayPal-Request-Id": init.idempotencyKey ?? randomUUID() } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = json?.details?.[0]?.description || json?.message || `PayPal ${res.status}`;
    throw new PayPalError(msg, res.status, json);
  }
  return json as T;
}

const sim = (prefix: string) => `SIM-${prefix}-${randomBytes(5).toString("hex").toUpperCase()}`;

// ---------------------------------------------------------------- Orders ----

export async function createDonationOrder(c: PayPalConn, args: { amount: number; fundId: string; fundTitle: string; reference: string }) {
  if (!c.live) return { id: sim("ORDER"), status: "CREATED", live: false };
  const value = toValue(args.amount);
  // PayPal only accepts items.category=DONATION from accounts approved for
  // donations (a 403 otherwise). Ask with it first, and fall back to an
  // uncategorised item so an ordinary business or sandbox account still works.
  try {
    return await placeOrder(c, args, value, true);
  } catch (e) {
    if (e instanceof PayPalError && e.status === 403 && /DONATION/i.test(e.message)) return placeOrder(c, args, value, false);
    throw e;
  }
}

async function placeOrder(c: PayPalConn, args: { fundId: string; fundTitle: string; reference: string }, value: string, donationCategory: boolean) {
  const order = await api<{ id: string; status: string }>(c, "/v2/checkout/orders", {
    method: "POST",
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: args.fundId,
          custom_id: args.reference,
          description: `Donation to ${args.fundTitle}`.slice(0, 127),
          soft_descriptor: "CLEARAID",
          amount: {
            currency_code: "USD",
            value,
            breakdown: { item_total: { currency_code: "USD", value } },
          },
          items: [
            {
              name: `Donation: ${args.fundTitle}`.slice(0, 127),
              quantity: "1",
              ...(donationCategory ? { category: "DONATION" } : {}),
              unit_amount: { currency_code: "USD", value },
            },
          ],
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "ClearAid",
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
          },
        },
      },
    },
  });
  return { id: order.id, status: order.status, live: true };
}

export interface CaptureResult {
  orderId: string;
  captureId: string;
  status: string;
  amount: number;
  payerEmail?: string;
  payerName?: string;
  live: boolean;
}

export async function captureDonationOrder(c: PayPalConn, orderId: string, simulatedAmount: number): Promise<CaptureResult> {
  if (!c.live) {
    return { orderId, captureId: sim("CAP"), status: "COMPLETED", amount: simulatedAmount, live: false };
  }
  type Cap = {
    id: string;
    status: string;
    payer?: { email_address?: string; name?: { given_name?: string; surname?: string } };
    purchase_units: { payments: { captures: { id: string; status: string; amount: { value: string } }[] } }[];
  };
  const r = await api<Cap>(c, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST", body: {} });
  const cap = r.purchase_units?.[0]?.payments?.captures?.[0];
  if (!cap) throw new PayPalError("Capture missing from PayPal response", 502, r);
  return {
    orderId,
    captureId: cap.id,
    status: cap.status,
    amount: Math.round(Number(cap.amount.value) * 100),
    payerEmail: r.payer?.email_address,
    payerName: [r.payer?.name?.given_name, r.payer?.name?.surname].filter(Boolean).join(" ") || undefined,
    live: true,
  };
}

// --------------------------------------------------------------- Refunds ----

export async function refundCapture(c: PayPalConn, captureId: string, amount: number, note: string) {
  if (!c.live || captureId.startsWith("SIM-")) {
    return { id: sim("REFUND"), status: "COMPLETED", live: false };
  }
  const r = await api<{ id: string; status: string }>(c, `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    method: "POST",
    body: { amount: { currency_code: "USD", value: toValue(amount) }, note_to_payer: note.slice(0, 255) },
  });
  return { id: r.id, status: r.status, live: true };
}

// --------------------------------------------------------------- Payouts ----

export async function sendVendorPayout(c: PayPalConn, args: { withdrawalId: string; email: string; amount: number; note: string }) {
  return sendPayout(c, { itemId: args.withdrawalId, email: args.email, amount: args.amount, note: args.note, subject: "ClearAid relief payment", message: "You have received a verified relief payment through ClearAid." });
}

/**
 * One payout to one PayPal email. `itemId` is ClearAid's id for it (a vendor
 * payment or a donor return); PayPal sends it back on the payout's webhook
 * events, and it makes a retried call harmless (same batch id).
 */
export async function sendPayout(c: PayPalConn, args: { itemId: string; email: string; amount: number; note: string; subject: string; message: string }) {
  if (!c.live) return { batchId: sim("PAYOUT"), status: "SUCCESS", live: false };
  const r = await api<{ batch_header: { payout_batch_id: string; batch_status: string } }>(c, "/v1/payments/payouts", {
    method: "POST",
    idempotencyKey: `payout-${args.itemId}`,
    body: {
      sender_batch_header: {
        sender_batch_id: `clearaid-${args.itemId}`,
        email_subject: args.subject.slice(0, 255),
        email_message: args.message.slice(0, 1000),
      },
      items: [
        {
          recipient_type: "EMAIL",
          amount: { value: toValue(args.amount), currency: "USD" },
          note: args.note.slice(0, 4000),
          sender_item_id: args.itemId,
          receiver: args.email,
        },
      ],
    },
  });
  return { batchId: r.batch_header.payout_batch_id, status: r.batch_header.batch_status, live: true };
}

// -------------------------------------------------------------- Webhooks ----

export async function verifyWebhook(c: PayPalConn, headers: Headers, event: unknown): Promise<boolean> {
  if (!c.live || !c.webhookId) return false;
  const r = await api<{ verification_status: string }>(c, "/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: {
      auth_algo: headers.get("paypal-auth-algo"),
      cert_url: headers.get("paypal-cert-url"),
      transmission_id: headers.get("paypal-transmission-id"),
      transmission_sig: headers.get("paypal-transmission-sig"),
      transmission_time: headers.get("paypal-transmission-time"),
      webhook_id: c.webhookId,
      webhook_event: event,
    },
  });
  return r.verification_status === "SUCCESS";
}

// ------------------------------------------------------------- Reporting ----

export async function listRecentTransactions(c: PayPalConn, days = 30) {
  if (!c.live) return null;
  const end = new Date();
  const start = new Date(end.getTime() - Math.min(days, 31) * 86400_000);
  const q = new URLSearchParams({
    start_date: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
    end_date: end.toISOString().replace(/\.\d{3}Z$/, "Z"),
    fields: "transaction_info",
    page_size: "200",
  });
  return api<{ transaction_details: { transaction_info: Record<string, unknown> }[] }>(c, `/v1/reporting/transactions?${q}`);
}
