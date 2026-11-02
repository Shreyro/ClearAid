import { randomBytes, randomUUID } from "node:crypto";
import { config, paypalApiBase, paypalLive } from "./config";
import { toValue } from "./money";

/**
 * Thin PayPal REST client (Orders v2, Payments v2 refunds, Payouts v1,
 * webhook verification). When no credentials are configured every call is
 * simulated so the full product can be demoed offline; simulated IDs are
 * prefixed with "SIM-" and the UI labels them as such.
 */

export class PayPalError extends Error {
  constructor(message: string, public status: number, public details?: unknown) {
    super(message);
  }
}

let cachedToken: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const auth = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString("base64");
  const res = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) throw new PayPalError(json.error_description || "PayPal auth failed", res.status, json);
  cachedToken = { token: json.access_token, exp: Date.now() + (json.expires_in ?? 3000) * 1000 };
  return json.access_token;
}

export async function paypalAccessToken() {
  return accessToken();
}

async function api<T>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${paypalApiBase()}${path}`, {
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

export async function createDonationOrder(args: { amount: number; fundId: string; fundTitle: string; reference: string }) {
  if (!paypalLive()) return { id: sim("ORDER"), status: "CREATED", live: false };
  const value = toValue(args.amount);
  const order = await api<{ id: string; status: string }>("/v2/checkout/orders", {
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
              category: "DONATION",
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

export async function captureDonationOrder(orderId: string, simulatedAmount: number): Promise<CaptureResult> {
  if (!paypalLive()) {
    return { orderId, captureId: sim("CAP"), status: "COMPLETED", amount: simulatedAmount, live: false };
  }
  type Cap = {
    id: string;
    status: string;
    payer?: { email_address?: string; name?: { given_name?: string; surname?: string } };
    purchase_units: { payments: { captures: { id: string; status: string; amount: { value: string } }[] } }[];
  };
  const r = await api<Cap>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST", body: {} });
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

export async function refundCapture(captureId: string, amount: number, note: string) {
  if (!paypalLive() || captureId.startsWith("SIM-")) {
    return { id: sim("REFUND"), status: "COMPLETED", live: false };
  }
  const r = await api<{ id: string; status: string }>(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    method: "POST",
    body: { amount: { currency_code: "USD", value: toValue(amount) }, note_to_payer: note.slice(0, 255) },
  });
  return { id: r.id, status: r.status, live: true };
}

// --------------------------------------------------------------- Payouts ----

export async function sendVendorPayout(args: { withdrawalId: string; email: string; amount: number; note: string }) {
  if (!paypalLive()) return { batchId: sim("PAYOUT"), status: "SUCCESS", live: false };
  const r = await api<{ batch_header: { payout_batch_id: string; batch_status: string } }>("/v1/payments/payouts", {
    method: "POST",
    idempotencyKey: `payout-${args.withdrawalId}`,
    body: {
      sender_batch_header: {
        sender_batch_id: `clearaid-${args.withdrawalId}`,
        email_subject: "ClearAid relief payment",
        email_message: "You have received a verified relief payment through ClearAid.",
      },
      items: [
        {
          recipient_type: "EMAIL",
          amount: { value: toValue(args.amount), currency: "USD" },
          note: args.note.slice(0, 4000),
          sender_item_id: args.withdrawalId,
          receiver: args.email,
        },
      ],
    },
  });
  return { batchId: r.batch_header.payout_batch_id, status: r.batch_header.batch_status, live: true };
}

// -------------------------------------------------------------- Webhooks ----

export async function verifyWebhook(headers: Headers, event: unknown): Promise<boolean> {
  if (!paypalLive() || !config.paypal.webhookId) return false;
  const r = await api<{ verification_status: string }>("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: {
      auth_algo: headers.get("paypal-auth-algo"),
      cert_url: headers.get("paypal-cert-url"),
      transmission_id: headers.get("paypal-transmission-id"),
      transmission_sig: headers.get("paypal-transmission-sig"),
      transmission_time: headers.get("paypal-transmission-time"),
      webhook_id: config.paypal.webhookId,
      webhook_event: event,
    },
  });
  return r.verification_status === "SUCCESS";
}

// ------------------------------------------------------------- Reporting ----

export async function listRecentTransactions(days = 30) {
  if (!paypalLive()) return null;
  const end = new Date();
  const start = new Date(end.getTime() - Math.min(days, 31) * 86400_000);
  const q = new URLSearchParams({
    start_date: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
    end_date: end.toISOString().replace(/\.\d{3}Z$/, "Z"),
    fields: "transaction_info",
    page_size: "200",
  });
  return api<{ transaction_details: { transaction_info: Record<string, unknown> }[] }>(`/v1/reporting/transactions?${q}`);
}
