/**
 * Create dummy bank accounts in the Plaid sandbox, filled with an NGO's kind of
 * transactions, and connect them to a running ClearAid, exactly as an admin
 * pressing "Connect with Plaid" would.
 *
 *   npm run plaid:sandbox-banks
 *   npm run plaid:sandbox-banks -- --app http://localhost:3000 --user priya --password admin-demo --days 90 --seed 7
 *   npm run plaid:sandbox-banks -- --paypal main      (or a PayPal account's id or name in ClearAid)
 *
 * With --paypal, the operations checking account also gets "PAYPAL TRANSFER"
 * deposits for most of what that PayPal account has collected in ClearAid (less
 * PayPal-like fees), as if its balance were withdrawn to the bank, and the two
 * are linked so the deposits are recognised as transfers, not new money.
 *
 * Uses PLAID_CLIENT_ID / PLAID_SECRET from backend/.env (sandbox only). Two bank
 * logins are created with Plaid's "custom user": an operations bank (checking and
 * savings) and a field-office credit union account. About a third of the lines
 * carry the funds' own tracking codes (read from ClearAid), so they're tagged on
 * import; others have no code (they wait in Untagged), some are bank fees, and
 * some name private individuals (they're anonymised on import).
 */

function arg(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APP = arg("app", process.env.CLEARAID_URL || "http://localhost:3000").replace(/\/$/, "");
const USER = arg("user", "priya");
const PASSWORD = arg("password", "admin-demo");
const DAYS = Math.min(700, Math.max(14, Number(arg("days", "90"))));
const PAYPAL = arg("paypal", "");
let seed = Number(arg("seed", String(Date.now() % 100000))) >>> 0 || 1;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const between = (lo: number, hi: number) => Math.round((lo + rand() * (hi - lo)) * 100) / 100;

if ((process.env.PLAID_ENV ?? "sandbox") !== "sandbox") {
  console.error("This only runs against the Plaid sandbox (PLAID_ENV=sandbox).");
  process.exit(1);
}
if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
  console.error("Set PLAID_CLIENT_ID and PLAID_SECRET (sandbox) in backend/.env first.");
  process.exit(1);
}

// ------------------------------------------------------------- APIs ----

async function plaid<T>(path: string, body: object): Promise<T> {
  const r = await fetch(`https://sandbox.plaid.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET, ...body }),
  });
  const j = (await r.json()) as T & { error_code?: string; error_message?: string };
  if (!r.ok) throw new Error(`Plaid ${path}: ${j.error_code} ${j.error_message}`);
  return j;
}

let cookie = "";
async function app<T>(path: string, body?: object): Promise<T> {
  const r = await fetch(`${APP}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(`ClearAid ${path}: ${j.error ?? r.status}`);
  return j;
}

// ------------------------------------------------------- transactions ----

type Txn = { date_transacted: string; date_posted: string; amount: number; description: string; currency: "USD" };
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
/** Plaid's sign: money out is positive, money in negative. */
function txn(daysAgo: number, amount: number, description: string): Txn {
  const posted = Math.max(1, daysAgo - (rand() < 0.6 ? 1 : 0));
  return { date_transacted: dayAgo(daysAgo), date_posted: dayAgo(posted), amount, description: description.slice(0, 120), currency: "USD" };
}

const PEOPLE = ["Anita Rao", "Ravi Kumar", "Meena Das", "Sanjay Patnaik", "Lakshmi Nair", "Arjun Mehta", "Priyanka Sahu", "Deepak Jena", "Farah Khan", "Tomas Ruiz"];
const DONORS_ORG = ["Rotary Club of Puri", "Harbor Foundation", "Kalinga Mills CSR", "Global Giving Circle", "Coastal Community Foundation", "Lumen Credit Union"];
const VENDORS: { name: string; sub: string; what: string[]; lo: number; hi: number }[] = [
  { name: "AquaPure Water Systems", sub: "WATER", what: ["jerrycans", "water tanker", "chlorine tablets"], lo: 300, hi: 2600 },
  { name: "Kalinga Rice & Pulses Traders", sub: "FOOD", what: ["family rations", "rice 2t", "dal and oil"], lo: 800, hi: 3800 },
  { name: "ShelterKit India", sub: "SHL", what: ["tarpaulin kits", "rope and poles", "shelter kits"], lo: 600, hi: 3200 },
  { name: "MedLine Pharma Distributors", sub: "MED", what: ["clinic restock", "ORS sachets", "first-aid kits"], lo: 400, hi: 2400 },
  { name: "RapidMove Logistics", sub: "LOG", what: ["truck hire", "boat transport", "warehouse handling"], lo: 150, hi: 1200 },
  { name: "CleanHands Hygiene Supplies", sub: "HYG", what: ["hygiene kits", "sanitary pads", "buckets"], lo: 250, hi: 1500 },
];

/** Codes to put on lines: each open fund's first tracking code (read from ClearAid). */
function operations(codes: string[]) {
  const checking: Txn[] = [];
  const savings: Txn[] = [];
  const code = () => pick(codes);
  for (let d = DAYS; d >= 1; d--) {
    // Money in
    if (rand() < 0.12) checking.push(txn(d, -between(1500, 9000), `RTGS CR ${pick(DONORS_ORG)} grant #${code()}`));
    if (rand() < 0.25) checking.push(txn(d, -between(25, 600), `NEFT CR ${pick(PEOPLE)} donation #${code()}`));
    if (rand() < 0.08) checking.push(txn(d, -between(20, 300), `IMPS CR from ${pick(PEOPLE)}`)); // no code: waits in Untagged
    // Money out to suppliers
    if (rand() < 0.22) {
      const v = pick(VENDORS);
      const tagged = rand() < 0.75;
      checking.push(txn(d, between(v.lo, v.hi), `NEFT DR ${v.name} ${pick(v.what)}${tagged ? ` #${code()}-${v.sub}` : ""}`));
    }
    if (rand() < 0.04) checking.push(txn(d, between(80, 400), `Card purchase Office supplies Bhubaneswar #${code()}-ADM`));
    // Fees
    if (d % 30 === 3) checking.push(txn(d, 15, "Monthly account maintenance SERVICE CHARGE"));
    if (rand() < 0.03) checking.push(txn(d, 25, "SWIFT CHG inward remittance"));
    // Savings: monthly interest, occasional sweep from checking
    if (d % 30 === 1) savings.push(txn(d, -between(8, 30), "Interest credit"));
    if (d % 45 === 7) {
      const amt = between(2000, 5000);
      checking.push(txn(d, amt, "Transfer to savings ••4411"));
      savings.push(txn(d, -amt, "Transfer from operations ••4410"));
    }
  }
  return [
    { type: "depository", subtype: "checking", starting_balance: 42000, currency: "USD", meta: { name: "Relief Operations Checking", official_name: "Relief Operations Business Checking", mask: "4410" }, transactions: checking },
    { type: "depository", subtype: "savings", starting_balance: 15000, currency: "USD", meta: { name: "Relief Reserve Savings", official_name: "Relief Reserve Business Savings", mask: "4411" }, transactions: savings },
  ];
}

/** "PAYPAL TRANSFER" deposits for about 80% of what's still in the PayPal account, less ~3% fees, in 3 to 5 withdrawals. */
function paypalWithdrawals(stillInPayPalCents: number) {
  const total = Math.round(stillInPayPalCents * 0.8 * 0.97) / 100;
  const n = Math.min(5, Math.max(1, Math.floor(total / 150)), 3 + Math.floor(rand() * 3));
  const weights = Array.from({ length: n }, () => 0.5 + rand());
  const sum = weights.reduce((a, b) => a + b, 0);
  const amounts = weights.map((w) => Math.round((total * w) / sum * 100) / 100);
  return amounts.map((amt, i) => txn(Math.max(2, Math.round(DAYS - ((i + 1) * DAYS) / (n + 1))), -amt, `PAYPAL TRANSFER PPD ID: PAYPALSD11 ${Math.floor(rand() * 1e9)}`));
}

function fieldOffice(codes: string[]) {
  const t: Txn[] = [];
  for (let d = DAYS; d >= 1; d--) {
    if (d % 14 === 5) t.push(txn(d, -between(1000, 3000), "Transfer from operations ••4410 field float"));
    if (rand() < 0.15) t.push(txn(d, between(100, 500), `ATM CASH WDL ${pick(["Puri", "Paradip", "Gopalpur", "Kendrapara"])} card 7730`));
    if (rand() < 0.18) t.push(txn(d, between(30, 140), `Fuel station ${pick(["Paradip", "Puri", "Cuttack"])} card 7730${rand() < 0.5 ? ` #${pick(codes)}-LOG` : ""}`));
    if (rand() < 0.07) t.push(txn(d, between(60, 400), `Local boat hire ${pick(PEOPLE)} #${pick(codes)}-LOG`)); // a person: anonymised
    if (rand() < 0.05) t.push(txn(d, between(40, 250), `Cash aid to ${pick(PEOPLE)} family #${pick(codes)}-CASH`));
    if (d % 30 === 10) t.push(txn(d, 5, "SMS alert SERVICE CHARGE"));
  }
  return [{ type: "depository", subtype: "checking", starting_balance: 3500, currency: "USD", meta: { name: "District Field Office Checking", official_name: "Field Office Checking", mask: "7730" }, transactions: t }];
}

// ------------------------------------------------------------- main ----

async function connect(institutionId: string, label: string, accounts: object[]): Promise<{ id: string; name: string }[]> {
  const config = { version: "2", override_accounts: accounts };
  const { public_token } = await plaid<{ public_token: string }>("/sandbox/public_token/create", {
    institution_id: institutionId,
    initial_products: ["transactions"],
    options: { override_username: "user_custom", override_password: JSON.stringify(config) },
  });
  // The same call the browser makes after Plaid Link: ClearAid exchanges it and stores the token encrypted.
  const r = await app<{ accounts: { id: string; name: string }[] }>("/api/bank/plaid", { action: "exchange", publicToken: public_token, institution: label });
  const lines = (accounts as { transactions: Txn[] }[]).reduce((s, a) => s + a.transactions.length, 0);
  console.log(`Connected ${label}: ${r.accounts.map((a) => a.name).join(", ")} (${lines} transactions over ${DAYS} days)`);
  return r.accounts;
}

type PayPalAcc = { id: string; name: string; status: string; reconciliation?: { stillInPayPal: number } };
/** The PayPal account --paypal names ("main", an id or a name), and the withdrawals to add for it. */
async function paypalPlan() {
  if (!PAYPAL) return null;
  const { accounts } = await app<{ accounts: PayPalAcc[] }>("/api/paypal/accounts");
  const want = PAYPAL.toLowerCase();
  const pp = accounts.find((a) => a.id.toLowerCase() === want || a.name.toLowerCase() === want || (want === "main" && a.id === "pp_default"));
  if (!pp) throw new Error(`No PayPal account "${PAYPAL}" in ClearAid. Try: ${accounts.map((a) => `"${a.name}" (${a.id})`).join(", ")}`);
  const still = pp.reconciliation?.stillInPayPal ?? 0;
  if (still < 5000) {
    console.log(`${pp.name} has only $${(still / 100).toFixed(2)} still in PayPal by ClearAid's records, so no withdrawals were added.`);
    return null;
  }
  return { pp, txns: paypalWithdrawals(still) };
}

async function main() {
  await app("/api/auth/login", { username: USER, password: PASSWORD });
  const { funds } = await app<{ funds: { status: string; trackingCodes: string[] }[] }>("/api/funds");
  const codes = funds.filter((f) => f.status === "active" && f.trackingCodes?.length).map((f) => f.trackingCodes[0]);
  if (!codes.length) throw new Error("No open fund has a tracking code; give one a code under Settings → Funds first");
  console.log(`ClearAid at ${APP} · open funds' codes: ${codes.map((c) => `#${c}`).join(", ")}`);

  const plan = await paypalPlan();
  const ops = operations(codes);
  if (plan) (ops[0].transactions as Txn[]).push(...plan.txns);
  const opsAccounts = await connect("ins_109508", "Coastal Community Bank (sandbox)", ops);
  if (plan) {
    // Link before the first sync, so the deposits are recognised as transfers as they arrive.
    const checking = opsAccounts.find((a) => /4410/.test(a.name)) ?? opsAccounts[0];
    await app("/api/bank/accounts", { action: "update", id: checking.id, transfersFrom: [plan.pp.id] });
    const sum = plan.txns.reduce((s, t) => s - t.amount, 0);
    console.log(`Added ${plan.txns.length} PayPal withdrawals from "${plan.pp.name}" ($${sum.toFixed(2)}) to ${checking.name}, and linked the two.`);
  }
  await connect("ins_109509", "District Credit Union (sandbox)", fieldOffice(codes));

  // Plaid prepares the history in the background; pull it once it's ready.
  process.stdout.write("Waiting for Plaid to prepare the history");
  let imported = 0;
  for (let i = 0; i < 20 && !imported; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    process.stdout.write(".");
    imported = (await app<{ imported: number }>("/api/bank/plaid", { action: "sync_all" })).imported;
  }
  console.log(imported ? `\nImported ${imported} transactions. Open Sources, Transactions and Untagged in ClearAid.` : "\nPlaid is still preparing them; press Sync all banks on Sources in a minute.");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
