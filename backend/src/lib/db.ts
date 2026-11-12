import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config";
import { appendLedger } from "./ledger";
import { hashPassword } from "./password";
import { buildSeed, DEMO_LOGINS } from "./seed";
import { seedFieldAccount, seedPayPalAccounts } from "./seed-bank";
import type { DB } from "./types";

/**
 * Tiny JSON-file store. Good enough for a single-instance hackathon deploy
 * (attach a persistent disk at DATA_DIR on Render). All mutations go through
 * `mutate`, which persists atomically (write temp file, then rename).
 */

const DB_VERSION = 7;
const dbFile = () => path.join(config.dataDir, "db.json");
export const uploadsDir = () => path.join(config.dataDir, "uploads");

type Holder = { db?: DB; locks: Map<string, Promise<unknown>> };
const g = globalThis as unknown as { __clearaid?: Holder };
const holder: Holder = (g.__clearaid ??= { locks: new Map() });

function persist(db: DB) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = `${dbFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, dbFile());
}

/**
 * Data saved before donor logins existed has no demo donor. Add it to the demo
 * NGO so it appears on the sign-in page without resetting everyone's changes.
 * Skipped if the username is already taken.
 */
function addDemoDonor(db: DB) {
  const login = DEMO_LOGINS.find((l) => l.memberId === "dnr_maya");
  const ngo = db.ngos.find((n) => n.id === "ngo_crc");
  if (!login || !ngo || db.ngos.some((n) => n.members.some((m) => m.id === login.memberId || m.username === login.username))) return false;
  ngo.members.push({ id: login.memberId, name: "Maya Chen", title: "Donor", username: login.username, passwordHash: hashPassword(login.password), role: "donor", active: true, createdAt: new Date().toISOString() });
  return true;
}

/**
 * Donors used to see every fund; now an admin assigns them. Data saved before
 * that has no fund with viewers at all, so give the demo donor the Asha fund
 * (like a fresh seed) rather than leaving her with nothing to look at.
 */
function seedDonorFunds(db: DB) {
  if (db.funds.some((f) => f.viewers)) return false;
  const maya = db.ngos.flatMap((n) => n.members).find((m) => m.id === "dnr_maya");
  const asha = db.funds.find((f) => f.id === "fund_asha");
  for (const f of db.funds) f.viewers = [];
  if (maya && asha) asha.viewers = [maya.id];
  return true;
}

function load(): DB {
  if (holder.db) return holder.db;
  try {
    const parsed = JSON.parse(fs.readFileSync(dbFile(), "utf8")) as DB;
    if (parsed.version === DB_VERSION) {
      const added = addDemoDonor(parsed);
      // Data saved before an NGO could have several accounts: add the demo's second bank and PayPal accounts (not on clean data).
      const accounts = parsed.seedMode === "clean" ? false : [seedFieldAccount(parsed, Date.now()), seedPayPalAccounts(parsed, Date.now())].some(Boolean);
      if (seedDonorFunds(parsed) || added || accounts) persist(parsed);
      holder.db = parsed;
      return parsed;
    }
  } catch {
    /* fall through to seeding */
  }
  const seeded = buildSeed(DB_VERSION);
  persist(seeded);
  holder.db = seeded;
  return seeded;
}

export function getDb(): DB {
  return load();
}

/** Called after every saved change (and after a reset), e.g. to refresh the Copilot's search index. */
const listeners = new Set<() => void>();
export function onDbChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error("[clearaid] change listener failed", e);
    }
  }
};

export function mutate<T>(fn: (db: DB) => T): T {
  const db = load();
  const out = fn(db);
  persist(db);
  changed();
  return out;
}

/**
 * Start again. "demo" restores the demo scenario. "clean" keeps the NGO, its
 * logins, funds (with their tracking codes and needs) and registered payees,
 * and nothing else: no donations, payments, bank or PayPal accounts, files or
 * history, ready to be filled from the PayPal and Plaid sandboxes.
 */
export function resetDb(mode: "demo" | "clean" = "demo") {
  holder.db = undefined;
  try {
    fs.rmSync(dbFile(), { force: true });
    fs.rmSync(uploadsDir(), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  let db = load();
  if (mode === "clean") {
    db = cleanSlate(db);
    holder.db = db;
    try {
      fs.rmSync(uploadsDir(), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    persist(db);
  }
  changed();
  return db;
}

function cleanSlate(seeded: DB): DB {
  const at = nowIso();
  const funds = seeded.funds.map((f) => {
    const { closingStartedAt: _c, closedAt: _d, returnBase: _r, insights: _i, carryForwardFundId: _cf, paypalAccountId: _p, ...rest } = f;
    return { ...rest, status: "active" as const, startedAt: at, needs: f.needs.map((n) => ({ ...n, fulfilledQty: 0 })) };
  });
  const db: DB = {
    version: seeded.version,
    seedMode: "clean",
    ngos: seeded.ngos,
    funds,
    donors: [],
    captures: [],
    donations: [],
    vendors: seeded.vendors,
    files: [],
    withdrawals: [],
    ledger: [],
    orders: [],
    processedWebhooks: [],
    assignmentRequests: [],
    auditLog: [],
    bankAccounts: [],
    statementImports: [],
    bankTxns: [],
    embeds: [],
  };
  // Each fund's ledger starts with its opening line, as when a fund is created.
  for (const f of db.funds) {
    appendLedger(db, { fundId: f.id, type: "fund_opened", amount: 0, memo: `Fund opened by ${db.ngos.find((n) => n.id === f.ngoId)?.name ?? "the NGO"}. Goal $${(f.goal / 100).toLocaleString()}.`, actor: db.ngos.find((n) => n.id === f.ngoId)?.name ?? "NGO" });
  }
  return db;
}

/** Serialise async work per key (e.g. per fund) so balances can't race. */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = holder.locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  holder.locks.set(key, prev.then(() => next));
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;
export const nowIso = () => new Date().toISOString();
