import path from "node:path";

export const config = {
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID?.trim() || "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET?.trim() || "",
    env: (process.env.PAYPAL_ENV === "live" ? "live" : "sandbox") as "live" | "sandbox",
    webhookId: process.env.PAYPAL_WEBHOOK_ID?.trim() || "",
  },
  anthropicKey: process.env.ANTHROPIC_API_KEY?.trim() || "",
  claudeModel: process.env.CLAUDE_MODEL?.trim() || "claude-opus-5-5",
  zapierWebhookUrl: process.env.ZAPIER_WEBHOOK_URL?.trim() || "",
  dataDir: path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || ".data"),
  appUrl: process.env.APP_URL || "http://localhost:3000",
};

export const paypalLive = () => Boolean(config.paypal.clientId && config.paypal.clientSecret);
export const aiEnabled = () => Boolean(config.anthropicKey);

export const paypalApiBase = () =>
  config.paypal.env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

export const paypalSdkUrl = () =>
  config.paypal.env === "live"
    ? "https://www.paypal.com/web-sdk/v6/core"
    : "https://www.sandbox.paypal.com/web-sdk/v6/core";
