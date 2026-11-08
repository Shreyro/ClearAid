import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { getDb } from "./db";
import type { DB, Fund, NgoMember, Session } from "./types";

export { hashPassword, verifyPassword } from "./password";

/**
 * Identity lives in one cookie. Only NGO staff sign in (username + password);
 * the cookie is "ngo:<memberId>:<hmac>", so it can't be forged by editing it.
 * Anyone without a valid cookie is signed out and can only reach sign-in.
 */
export const SESSION_COOKIE = "clearaid_persona";

/** The request being handled, so lib code can read cookies without threading it through. */
export const requestContext = new AsyncLocalStorage<Request>();

function readCookie(name: string) {
  const header = requestContext.getStore()?.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

// -------------------------------------------------------- Signed cookie ----

let secret: string | undefined;
/** Server-side secret (signs cookies; also derives the key that encrypts stored bank tokens). */
export function sessionSecret() {
  if (secret) return secret;
  if (process.env.SESSION_SECRET?.trim()) return (secret = process.env.SESSION_SECRET.trim());
  // Persist a random secret next to the data so sign-ins survive restarts.
  const file = path.join(config.dataDir, "session-secret");
  try {
    secret = fs.readFileSync(file, "utf8").trim();
  } catch {
    /* create below */
  }
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
  }
  return secret;
}

const sign = (value: string) => createHmac("sha256", sessionSecret()).update(value).digest("base64url");

/** Signed over the password-change time too, so resetting a password signs that person out everywhere. */
const signedPart = (m: NgoMember) => `ngo:${m.id}:${m.passwordChangedAt ?? ""}`;

export function ngoCookieValue(m: NgoMember) {
  return `ngo:${m.id}:${sign(signedPart(m))}`;
}

function validSignature(m: NgoMember, sig: string) {
  const want = Buffer.from(sign(signedPart(m)));
  const got = Buffer.from(sig ?? "");
  return want.length === got.length && timingSafeEqual(want, got);
}

// -------------------------------------------------------------- Session ----

export function findMember(db: DB, id?: string) {
  for (const n of db.ngos) {
    const m = n.members.find((x) => x.id === id);
    if (m) return { member: m, ngo: n };
  }
  return null;
}

export async function getSession(): Promise<Session> {
  const raw = readCookie(SESSION_COOKIE) ?? "";
  const [role, id, sig] = decodeURIComponent(raw).split(":");
  const db = getDb();
  if (role === "ngo") {
    const found = findMember(db, id);
    if (found?.member.active && validSignature(found.member, sig)) return { role, id, memberRole: found.member.role };
  }
  return { role: "public" };
}

/** The signed-in NGO member, shaped for the rest of the app. */
export function ngoMember(id?: string) {
  const found = findMember(getDb(), id);
  if (!found) return null;
  const { member: m, ngo } = found;
  return { id: m.id, name: m.name, title: m.title, role: m.role, ngoId: ngo.id, ngoName: ngo.name };
}
export type SignedInMember = NonNullable<ReturnType<typeof ngoMember>>;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function requireRole(role: Session["role"]) {
  const s = await getSession();
  if (s.role !== role) throw new HttpError(401, "Sign in to continue");
  return s;
}

/** Any signed-in NGO member. */
export async function requireNgo() {
  const s = await requireRole("ngo");
  return ngoMember(s.id)!;
}

/** An NGO admin (manages people, assignments, funds and vendors). */
export async function requireNgoAdmin() {
  const m = await requireNgo();
  if (m.role !== "admin") throw new HttpError(403, "Only NGO admins can do this");
  return m;
}

/** Is this member on the fund's approver list? */
export const isAssigned = (fund: Fund, memberId?: string) => Boolean(memberId && fund.assignees.includes(memberId));

/**
 * Can this session see the fund's private, NGO-only data (unredacted text,
 * private files, requests still being audited)? Admins see every fund of
 * their NGO; users only the funds they're assigned to.
 */
export function ngoCanSeeFund(session: Session, fund: Fund) {
  if (session.role !== "ngo") return false;
  const m = ngoMember(session.id);
  if (!m || m.ngoId !== fund.ngoId) return false;
  return m.role === "admin" || isAssigned(fund, m.id);
}

/** Active approvers on a fund (inactive members can't sign). */
export function activeAssignees(db: DB, fund: Fund): NgoMember[] {
  return fund.assignees.map((id) => findMember(db, id)?.member).filter((m): m is NgoMember => Boolean(m?.active));
}

/** Funds this session may see in full. */
export const visibleFunds = (db: DB, session: Session) => db.funds.filter((f) => ngoCanSeeFund(session, f));

/** Resolve a fund by id or slug and check the signed-in member may see it. */
export async function requireFundAccess(idOrSlug: string) {
  const session = await requireRole("ngo");
  const fund = getDb().funds.find((f) => f.id === idOrSlug || f.slug === idOrSlug);
  if (!fund) throw new HttpError(404, "Fund not found");
  if (!ngoCanSeeFund(session, fund)) throw new HttpError(403, "You're not assigned to this fund. Ask an admin for access.");
  return { fund, session };
}

/** The audit-log actor for a signed-in member. */
export const actorOf = (m: { id: string; name: string }) => ({ id: m.id, name: m.name });
