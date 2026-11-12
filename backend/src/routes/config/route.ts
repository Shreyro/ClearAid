import { aiEnabled, config, renderMode, paypalLive, paypalSdkUrl } from "@/lib/config";
import { json } from "@/lib/http";

export async function GET() {
  return json({
    paypal: { live: paypalLive(), env: config.paypal.env, clientId: paypalLive() ? config.paypal.clientId : null, sdkUrl: paypalSdkUrl(), webhooks: Boolean(config.paypal.webhookId) },
    // All AI is local: one model for text, a vision model only when an image has to be read.
    ai: { enabled: aiEnabled(), renderMode, local: true, model: config.local.model, visionModel: config.local.visionModel },
  });
}
