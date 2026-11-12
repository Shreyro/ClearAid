import path from "node:path";

/** Host of the AI service on a private network (e.g. Render's `clearaid-ai`); the two URLs below are derived from it. */
const aiHost = process.env.AI_HOST?.trim() || "";

export const config = {
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID?.trim() || "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET?.trim() || "",
    env: (process.env.PAYPAL_ENV === "live" ? "live" : "sandbox") as "live" | "sandbox",
    webhookId: process.env.PAYPAL_WEBHOOK_ID?.trim() || "",
    /**
     * ClearAid's own PayPal partner (platform) app. With it, NGOs connect their
     * PayPal accounts by logging in to PayPal instead of pasting keys.
     */
    partner: {
      clientId: process.env.PAYPAL_PARTNER_CLIENT_ID?.trim() || "",
      clientSecret: process.env.PAYPAL_PARTNER_CLIENT_SECRET?.trim() || "",
      /** The partner's own PayPal merchant (payer) ID, e.g. from the sandbox account's details. */
      merchantId: process.env.PAYPAL_PARTNER_MERCHANT_ID?.trim() || "",
      /** Webhook ID of the partner app's webhook (URL: <public>/api/paypal/webhook?account=partner). */
      webhookId: process.env.PAYPAL_PARTNER_WEBHOOK_ID?.trim() || "",
      /** PayPal partner attribution (BN) code, if PayPal gave one. */
      bnCode: process.env.PAYPAL_PARTNER_BN_CODE?.trim() || "",
    },
  },
  plaid: {
    clientId: process.env.PLAID_CLIENT_ID?.trim() || "",
    secret: process.env.PLAID_SECRET?.trim() || "",
    env: (process.env.PLAID_ENV === "production" ? "production" : "sandbox") as "production" | "sandbox",
    /** Where banks that log in on their own site (OAuth) send the person back: https://<app>/oauth/plaid. Register it in the Plaid dashboard. */
    redirectUri: process.env.PLAID_REDIRECT_URI?.trim() || "",
    /** Public URL of /api/plaid/webhook, so Plaid can say when new transactions are ready. */
    webhookUrl: process.env.PLAID_WEBHOOK_URL?.trim() || "",
    /** Countries whose banks Link offers, e.g. "US,CA,GB". */
    countryCodes: (process.env.PLAID_COUNTRY_CODES?.trim() || "US").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean),
    /** How much history to ask for when a bank is connected (Plaid allows up to 730 days). */
    historyDays: Math.min(730, Math.max(30, Number(process.env.PLAID_HISTORY_DAYS) || 730)),
    /** Sync every connected bank this often, as a fallback to webhooks. 0 turns it off. */
    syncMinutes: Math.max(0, Number(process.env.PLAID_SYNC_MINUTES ?? 60) || 0),
  },
  dataDir: path.resolve(process.env.DATA_DIR || ".data"),
  appUrl: process.env.APP_URL || "http://localhost:3000",
  /**
   * All AI runs locally: Ollama serves one model for everything (the Copilot,
   * fund drafts, insights, redaction, audits), plus a vision model only for
   * reading images when that model can't. The rag/ service does FAISS search.
   */
  local: {
    /** LOCAL_AI=off switches every AI feature to its non-AI fallback. */
    ai: process.env.LOCAL_AI?.trim().toLowerCase() !== "off",
    ollamaUrl: (process.env.OLLAMA_URL?.trim() || (aiHost ? `http://${aiHost}:11434` : "http://127.0.0.1:11434")).replace(/\/$/, ""),
    model: process.env.COPILOT_MODEL?.trim() || "llama3.1:8b",
    /** Used only for receipts and photos, and only if the main model can't see images. */
    visionModel: process.env.LOCAL_VISION_MODEL?.trim() || "llava",
    ragUrl: (process.env.RAG_URL?.trim() || (aiHost ? `http://${aiHost}:8790` : "http://127.0.0.1:8790")).replace(/\/$/, ""),
    ragToken: process.env.RAG_TOKEN?.trim() || "",
  },
  /**
   * Hosting the AI on its own Render service that sleeps when nobody is using it.
   * With a Render API key and the AI service's id, the backend suspends that
   * service after `idleMinutes` without AI use and resumes it on the next question.
   */
  render: {
    apiKey: process.env.RENDER_API_KEY?.trim() || "",
    aiServiceId: process.env.RENDER_AI_SERVICE_ID?.trim() || "",
    idleMinutes: Math.max(2, Number(process.env.AI_IDLE_MINUTES) || 10),
  },
};

export const paypalLive = () => Boolean(config.paypal.clientId && config.paypal.clientSecret);
/** NGOs can connect PayPal accounts by logging in (ClearAid's partner app is configured). */
export const paypalPartnerLive = () => Boolean(config.paypal.partner.clientId && config.paypal.partner.clientSecret && config.paypal.partner.merchantId);
/** Whether AI features try the local model (each still falls back if Ollama is down). */
export const aiEnabled = () => config.local.ai;

export const paypalApiBase = () =>
  config.paypal.env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

export const paypalSdkUrl = () =>
  config.paypal.env === "live"
    ? "https://www.paypal.com/web-sdk/v6/core"
    : "https://www.sandbox.paypal.com/web-sdk/v6/core";
