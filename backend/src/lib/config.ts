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
  anthropicKey: process.env.ANTHROPIC_API_KEY?.trim() || "",
  claudeModel: process.env.CLAUDE_MODEL?.trim() || "claude-opus-5-5",
  zapierWebhookUrl: process.env.ZAPIER_WEBHOOK_URL?.trim() || "",
  dataDir: path.resolve(process.env.DATA_DIR || ".data"),
  appUrl: process.env.APP_URL || "http://localhost:3000",
  /** Local Copilot: Ollama for the answering model, the rag/ service for FAISS search. */
  local: {
    ollamaUrl: (process.env.OLLAMA_URL?.trim() || "http://127.0.0.1:11434").replace(/\/$/, ""),
    model: process.env.COPILOT_MODEL?.trim() || "llama3.1:8b",
    ragUrl: (process.env.RAG_URL?.trim() || "http://127.0.0.1:8790").replace(/\/$/, ""),
    ragToken: process.env.RAG_TOKEN?.trim() || "",
  },
};

export const paypalLive = () => Boolean(config.paypal.clientId && config.paypal.clientSecret);
export const aiEnabled = () => Boolean(config.anthropicKey);

export const paypalApiBase = () =>
  config.paypal.env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

export const paypalSdkUrl = () =>
  config.paypal.env === "live"
    ? "https://www.paypal.com/web-sdk/v6/core"
    : "https://www.sandbox.paypal.com/web-sdk/v6/core";
