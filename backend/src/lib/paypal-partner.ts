import { config } from "./config";
import { checkCredentials, paypalBase, PayPalError, type PayPalConn } from "./paypal";

/**
 * Connecting an NGO's PayPal account by logging in (PayPal Partner Referrals).
 *
 * ClearAid's partner app asks PayPal for a sign-up link carrying a tracking ID
 * (the pending account's ID) and the permissions ClearAid needs: take payments
 * and refund them, on the NGO's behalf. The NGO logs in to PayPal (or creates a
 * business account), agrees, and PayPal sends them back with their merchant ID.
 * ClearAid then reads which permissions were granted before marking the
 * account active. No keys of the NGO's are ever seen or stored.
 */

const P = () => config.paypal.partner;

/** ClearAid's partner app as a PayPal connection (its own token; no merchant to act for). */
export const partnerConn = (): PayPalConn => ({
  id: "partner",
  name: "ClearAid partner app",
  env: config.paypal.env,
  live: Boolean(P().clientId && P().clientSecret),
  clientId: P().clientId,
  clientSecret: P().clientSecret,
  webhookId: P().webhookId,
  bnCode: P().bnCode || undefined,
});

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const c = partnerConn();
  // Reuses the token cache through checkCredentials' path: ask for a token, then call.
  const tokenRes = await fetch(`${paypalBase(c.env)}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!tokenRes.ok || !tok.access_token) throw new PayPalError(tok.error_description || "PayPal didn't accept ClearAid's partner app keys", tokenRes.status);
  const res = await fetch(`${paypalBase(c.env)}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json", ...(c.bnCode ? { "PayPal-Partner-Attribution-Id": c.bnCode } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new PayPalError(json?.details?.[0]?.description || json?.message || `PayPal ${res.status}`, res.status, json);
  return json as T;
}

/** The permissions ClearAid asks an NGO to grant. Payouts can't be granted to a partner, so they aren't asked for. */
export const PARTNER_FEATURES = ["PAYMENT", "REFUND"] as const;

/** A PayPal sign-up link for one pending account. `returnUrl` is where PayPal sends the NGO back. */
export async function referralLink(args: { trackingId: string; returnUrl: string; email?: string }) {
  const r = await call<{ links: { rel: string; href: string }[] }>("/v2/customer/partner-referrals", {
    method: "POST",
    body: {
      tracking_id: args.trackingId,
      ...(args.email ? { email: args.email } : {}),
      operations: [
        {
          operation: "API_INTEGRATION",
          api_integration_preference: {
            rest_api_integration: { integration_method: "PAYPAL", integration_type: "THIRD_PARTY", third_party_details: { features: [...PARTNER_FEATURES] } },
          },
        },
      ],
      products: ["EXPRESS_CHECKOUT"],
      legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
      partner_config_override: { return_url: args.returnUrl, return_url_description: "Back to ClearAid" },
    },
  });
  const link = r.links.find((l) => l.rel === "action_url")?.href;
  if (!link) throw new PayPalError("PayPal didn't return a sign-up link", 502, r);
  return link;
}

type Integration = {
  merchant_id: string;
  tracking_id?: string;
  primary_email?: string;
  primary_email_confirmed?: boolean;
  payments_receivable?: boolean;
  oauth_integrations?: { integration_type?: string; oauth_third_party?: { partner_client_id?: string; scopes?: string[] }[] }[];
};

/** What an NGO granted ClearAid, read from PayPal (never trusted from the return URL alone). */
export async function merchantStatus(merchantId: string) {
  const r = await call<Integration>(`/v1/customer/partners/${encodeURIComponent(P().merchantId)}/merchant-integrations/${encodeURIComponent(merchantId)}`);
  const scopes = (r.oauth_integrations ?? []).flatMap((o) => (o.oauth_third_party ?? []).flatMap((t) => t.scopes ?? []));
  return {
    merchantId: r.merchant_id,
    trackingId: r.tracking_id,
    email: r.primary_email,
    emailConfirmed: Boolean(r.primary_email_confirmed),
    paymentsReceivable: Boolean(r.payments_receivable),
    granted: (r.oauth_integrations ?? []).some((o) => o.integration_type === "OAUTH_THIRD_PARTY"),
    permissions: scopes.map((s) => s.replace(/^https?:\/\/[^ ]*\/(?=[^/]+$)/, "")).slice(0, 20),
  };
}

/** The merchant behind a tracking ID, for when the NGO didn't come back through the return link. */
export async function merchantForTracking(trackingId: string) {
  const r = await call<{ merchant_id?: string }>(`/v1/customer/partners/${encodeURIComponent(P().merchantId)}/merchant-integrations?tracking_id=${encodeURIComponent(trackingId)}`);
  return r.merchant_id ?? null;
}
