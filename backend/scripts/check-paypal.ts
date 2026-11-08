/**
 * Check the PayPal credentials in backend/.env against the sandbox (or live)
 * API without changing anything: get a token, then read one day of Transaction
 * Search. Run with `npm run paypal:check`.
 */
import { config, paypalApiBase, paypalLive } from "../src/lib/config";
import { listRecentTransactions, paypalAccessToken } from "../src/lib/paypal";

async function main() {
  if (!paypalLive()) {
    console.log("PayPal is in DEMO MODE: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are empty in backend/.env.");
    console.log("Get them at https://developer.paypal.com/dashboard/applications/sandbox (Apps & Credentials > Sandbox).");
    process.exit(1);
  }
  console.log(`Environment: ${config.paypal.env} (${paypalApiBase()})`);
  await paypalAccessToken();
  console.log("✓ OAuth token issued: client ID and secret are valid");
  try {
    const r = await listRecentTransactions(1);
    console.log(`✓ Transaction Search works (${r?.transaction_details.length ?? 0} transactions in the last 24h)`);
  } catch (e) {
    console.log(`! Transaction Search failed: ${(e as Error).message}`);
    console.log("  Enable \"Transaction search\" for the app in the developer dashboard; new apps can take a few hours.");
  }
  console.log(config.paypal.webhookId ? "✓ PAYPAL_WEBHOOK_ID is set" : "· PAYPAL_WEBHOOK_ID is empty: webhooks (refunds/disputes made in PayPal) won't be verified. Needs a public URL.");
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
