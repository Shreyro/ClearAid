import { aiEnabled, config, paypalLive, paypalSdkUrl } from "@/lib/config";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return json({
    paypal: { live: paypalLive(), env: config.paypal.env, clientId: paypalLive() ? config.paypal.clientId : null, sdkUrl: paypalSdkUrl(), webhooks: Boolean(config.paypal.webhookId) },
    ai: { enabled: aiEnabled(), model: config.claudeModel },
    zapier: Boolean(config.zapierWebhookUrl),
  });
}
