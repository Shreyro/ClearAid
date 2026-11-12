/**
 * Start ClearAid again with nothing but sandbox transactions:
 *
 *   1. Reset to a clean start (the NGO, logins, funds and payees; no money).
 *   2. Add the NGO's US sandbox PayPal business account (it accepts cards) and
 *      point every fund's donation link at it.
 *   3. Give to the funds with PayPal's test card: each gift is a real capture in
 *      the PayPal sandbox, recorded with the fund's tracking code.
 *   4. Connect dummy Plaid sandbox banks (scripts/plaid-sandbox-banks.ts), whose
 *      operations account receives withdrawals of that PayPal balance.
 *
 *   npm run sandbox:data
 *   npm run sandbox:data -- --app http://localhost:3000 --donations 30 --accounts ../../.env.sandbox-accounts
 *
 * PayPal keys come from the sandbox accounts file (NGO_CLIENT_ID, NGO_CLIENT_SECRET,
 * NGO_MERCHANT_EMAIL; never printed). Plaid keys come from backend/.env.
 * Everything is sandbox: no real money moves.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function arg(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APP = arg("app", process.env.CLEARAID_URL || "http://localhost:3000").replace(/\/$/, "");
const USER = arg("user", "priya");
const PASSWORD = arg("password", "admin-demo");
const DONATIONS = Math.min(100, Math.max(1, Number(arg("donations", "24"))));
const ACCOUNTS_FILE = path.resolve(arg("accounts", "../../.env.sandbox-accounts"));
let seed = Number(arg("seed", String(Date.now() % 100000))) >>> 0 || 1;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];

if (!fs.existsSync(ACCOUNTS_FILE)) {
  console.error(`Sandbox accounts file not found: ${ACCOUNTS_FILE} (pass --accounts <path>)`);
  process.exit(1);
}
const env = Object.fromEntries(
  fs
    .readFileSync(ACCOUNTS_FILE, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
for (const k of ["NGO_CLIENT_ID", "NGO_CLIENT_SECRET"]) {
  if (!env[k]) {
    console.error(`${k} is missing from ${ACCOUNTS_FILE}`);
    process.exit(1);
  }
}

let cookie = "";
async function app<T>(p: string, body?: object, retry = true): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${APP}${p}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    // A connection left idle (e.g. while the Plaid step ran) can be closed under us: try once more.
    if (retry) return app<T>(p, body, false);
    throw e;
  }
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(`ClearAid ${p}: ${j.error ?? r.status}`);
  return j;
}
const signIn = () => app("/api/auth/login", { username: USER, password: PASSWORD });

const NAMES = ["Asha Rao", "Ben Okafor", "Chloe Nguyen", "Dev Patel", "Elena Fischer", "Farid Haddad", "Grace Kim", "Hiro Tanaka", "Isha Iyer", "Jonas Brennan"];
const AMOUNTS = [10, 20, 25, 25, 40, 50, 50, 75, 100, 100, 150, 250, 500];

async function main() {
  await signIn();
  await app("/api/admin/reset", { mode: "clean" });
  await signIn();
  console.log(`Reset ${APP} to a clean start.`);

  const { account } = await app<{ account: { id: string; name: string } }>("/api/paypal/accounts", {
    action: "create",
    name: "NGO US account",
    email: env.NGO_MERCHANT_EMAIL || undefined,
    mode: "live",
    env: "sandbox",
    clientId: env.NGO_CLIENT_ID,
    clientSecret: env.NGO_CLIENT_SECRET,
    webhookId: env.NGO_WEBHOOK_ID || undefined,
  });
  console.log(`Added PayPal account "${account.name}" (keys checked with the PayPal sandbox).`);

  const { funds } = await app<{ funds: { id: string; slug: string; title: string; status: string; trackingCodes: string[] }[] }>("/api/funds");
  const open = funds.filter((f) => f.status === "active");
  for (const f of open) await app("/api/paypal/accounts", { action: "assign_fund", fundId: f.id, accountId: account.id });
  // One fund offers donors their share of the leftover back, so that feature has data too.
  await app(`/api/funds/${open[0].id}/returns`, { action: "setting", enabled: true });
  console.log(`Every open fund pays into it: ${open.map((f) => `${f.title} (#${f.trackingCodes[0] ?? "no code"})`).join(", ")}.`);

  process.stdout.write(`Giving ${DONATIONS} test-card donations through the PayPal sandbox`);
  let total = 0;
  for (let i = 0; i < DONATIONS; i++) {
    const fund = open[i % open.length];
    const k = (i % 10) + 1;
    const r = await app<{ amount: number }>(`/api/give/${fund.slug}/test-card`, {
      amountUsd: pick(AMOUNTS),
      name: NAMES[k - 1],
      // The sandbox personal (donor) accounts, so gifts carry a real sandbox email.
      email: env[`DONOR_${k}_EMAIL`] || `donor${k}@personal.example.com`,
      showName: rand() < 0.5,
      returnOptIn: fund.id === open[0].id && rand() < 0.5,
    });
    total += r.amount;
    process.stdout.write(".");
  }
  console.log(` $${(total / 100).toFixed(2)} captured.`);

  // Dummy Plaid banks; the operations account receives withdrawals of the PayPal balance.
  const plaidArgs = ["--app", APP, "--user", USER, "--password", PASSWORD, "--paypal", account.id, "--days", arg("days", "60"), "--seed", String(seed)];
  // tsx's own CLI, run by this Node: no shell, so nothing is re-parsed.
  const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
  const r = spawnSync(process.execPath, [tsxCli, "--env-file-if-exists=.env", "scripts/plaid-sandbox-banks.ts", ...plaidArgs], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("Connecting the Plaid sandbox banks failed (see above)");

  const pp = await app<{ accounts: { id: string; reconciliation: { collected: number; toBank: number; stillInPayPal: number; transfers: number } }[] }>("/api/paypal/accounts");
  const rec = pp.accounts.find((a) => a.id === account.id)!.reconciliation;
  console.log(`\nDone. "${account.name}": collected $${(rec.collected / 100).toFixed(2)}, $${(rec.toBank / 100).toFixed(2)} withdrawn to the bank in ${rec.transfers} transfers, $${(rec.stillInPayPal / 100).toFixed(2)} still in PayPal.`);
  console.log(`Sign in at ${APP} (${USER}). The gifts are also in the PayPal sandbox account ${env.NGO_MERCHANT_EMAIL ?? ""}.`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
