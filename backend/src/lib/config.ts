import path from "node:path";

export const config = {
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID?.trim() || "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET?.trim() || "",
    env: (process.env.PAYPAL_ENV === "live" ? "live" : "sandbox") as "live" | "sandbox",
    webhookId: process.env.PAYPAL_WEBHOOK_ID?.trim() || "",
  },
  plaid: {
    clientId: process.env.PLAID_CLIENT_ID?.trim() || "",
    secret: process.env.PLAID_SECRET?.trim() || "",
    env: (process.env.PLAID_ENV === "production" ? "production" : "sandbox") as "production" | "sandbox",
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
    ollamaUrl: (process.env.OLLAMA_URL?.trim() || "http://127.0.0.1:11434").replace(/\/$/, ""),
    model: process.env.COPILOT_MODEL?.trim() || "llama3.1:8b",
    /** Used only for receipts and photos, and only if the main model can't see images. */
    visionModel: process.env.LOCAL_VISION_MODEL?.trim() || "llava",
    ragUrl: (process.env.RAG_URL?.trim() || "http://127.0.0.1:8790").replace(/\/$/, ""),
    ragToken: process.env.RAG_TOKEN?.trim() || "",
  },
};

export const paypalLive = () => Boolean(config.paypal.clientId && config.paypal.clientSecret);
/** Whether AI features try the local model (each still falls back if Ollama is down). */
export const aiEnabled = () => config.local.ai;

export const paypalApiBase = () =>
  config.paypal.env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

export const paypalSdkUrl = () =>
  config.paypal.env === "live"
    ? "https://www.paypal.com/web-sdk/v6/core"
    : "https://www.sandbox.paypal.com/web-sdk/v6/core";
