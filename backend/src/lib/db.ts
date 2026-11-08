import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config";
import { buildSeed } from "./seed";
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

function load(): DB {
  if (holder.db) return holder.db;
  try {
    const parsed = JSON.parse(fs.readFileSync(dbFile(), "utf8")) as DB;
    if (parsed.version === DB_VERSION) {
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

export function mutate<T>(fn: (db: DB) => T): T {
  const db = load();
  const out = fn(db);
  persist(db);
  return out;
}

export function resetDb() {
  holder.db = undefined;
  try {
    fs.rmSync(dbFile(), { force: true });
    fs.rmSync(uploadsDir(), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return load();
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
