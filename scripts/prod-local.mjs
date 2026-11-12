#!/usr/bin/env node
/**
 * Run ClearAid locally the way it runs in production: Docker Compose, production
 * builds, fixed secrets, and a public HTTPS address (Cloudflare quick tunnel) so
 * PayPal and Plaid webhooks and banks that log in on their own site work.
 *
 *   node scripts/prod-local.mjs              start (or restart) everything
 *   node scripts/prod-local.mjs --no-tunnel  same, without a public address
 *   node scripts/prod-local.mjs --down       stop everything (data is kept)
 *
 * A quick tunnel gets a new address every time it starts, so run this again
 * after a restart: it reads the new address and wires it in.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV = path.join(root, ".env");
const args = new Set(process.argv.slice(2));
const tunnel = !args.has("--no-tunnel");

const compose = (...a) => {
  const r = spawnSync("docker", ["compose", ...a], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`docker compose ${a.join(" ")} failed`);
};
const composeOut = (...a) => execFileSync("docker", ["compose", ...a], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ---------------------------------------------------------------- .env ----
function readEnv() {
  if (!fs.existsSync(ENV)) fs.copyFileSync(path.join(root, ".env.example"), ENV);
  // One line ending throughout, so editing a line never joins it to the next.
  return fs.readFileSync(ENV, "utf8").replace(/\r\n?/g, "\n");
}
function setEnv(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^#?[ \\t]*${key}=[^\\n]*$`, "m");
  return re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
}
const getEnv = (text, key) => text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() ?? "";

if (args.has("--down")) {
  compose("--profile", "ollama", "--profile", "tunnel", "down");
  console.log("Stopped. Data is kept in the Docker volumes.");
  process.exit(0);
}

try {
  execFileSync("docker", ["version"], { stdio: "ignore" });
} catch {
  console.error("Docker isn't running. Start Docker Desktop and try again.");
  process.exit(1);
}

let env = readEnv();
// Production needs fixed secrets: generated once, then kept.
for (const key of ["SESSION_SECRET", "RAG_TOKEN"]) {
  if (!getEnv(env, key)) {
    env = setEnv(env, key, randomBytes(32).toString("hex"));
    console.log(`Generated ${key} in .env (keep it: changing SESSION_SECRET signs everyone out and makes saved keys unreadable).`);
  }
}

// Use an Ollama already running on this machine (models downloaded, GPU) if there is one.
let hostOllama = false;
try {
  hostOllama = (await fetch("http://127.0.0.1:11434/api/version", { signal: AbortSignal.timeout(2000) })).ok;
} catch {}
const profiles = [hostOllama ? null : "ollama", tunnel ? "tunnel" : null].filter(Boolean);
env = setEnv(env, "COMPOSE_PROFILES", profiles.join(","));
env = setEnv(env, "OLLAMA_URL", hostOllama ? "http://host.docker.internal:11434" : "http://ollama:11434");
console.log(hostOllama ? "Using the Ollama running on this machine." : "No Ollama on this machine: running it in a container (first start downloads the models).");

// ---------------------------------------------------------------- tunnel ----
let url = "";
if (tunnel) {
  fs.writeFileSync(ENV, env);
  compose("up", "-d", "--force-recreate", "tunnel");
  process.stdout.write("Waiting for the tunnel's address");
  for (let i = 0; i < 60 && !url; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    process.stdout.write(".");
    url = composeOut("logs", "--no-log-prefix", "tunnel").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? "";
  }
  console.log(url ? ` ${url}` : "");
  if (!url) {
    console.error("The tunnel didn't report an address. See: docker compose logs tunnel");
    process.exit(1);
  }
}
const publicUrl = url || `http://localhost:${getEnv(env, "WEB_PORT") || 3000}`;
env = setEnv(env, "PUBLIC_URL", publicUrl);
env = setEnv(env, "PLAID_REDIRECT_URI", url ? `${url}/oauth/plaid` : "");
env = setEnv(env, "PLAID_WEBHOOK_URL", url ? `${url}/api/plaid/webhook` : "");
fs.writeFileSync(ENV, env);

// ---------------------------------------------------------------- stack ----
compose("up", "-d", "--build", "--wait", "--wait-timeout", "600", "web", "backend", "rag");

console.log(`
ClearAid is running in production mode.
  On this machine:  http://localhost:${getEnv(env, "WEB_PORT") || 3000}
  Public address:   ${url || "(none; run without --no-tunnel for one)"}
`);
if (url) {
  console.log(`Each time the address changes, update these by hand:
  - Plaid dashboard > Developers > API > Allowed redirect URIs: add ${url}/oauth/plaid
  - PayPal developer dashboard > your app > Webhooks: set the URL to ${url}/api/paypal/webhook
    (and for each extra PayPal account: ${url}/api/paypal/webhook?account=<id>)
Plaid webhooks for connected banks are moved to the new address automatically.`);
}
