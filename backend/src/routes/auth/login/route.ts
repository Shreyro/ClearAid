import { audit } from "@/lib/audit";
import { roleLabel } from "@/lib/types";
import { getDb, mutate } from "@/lib/db";
import { handle, json, setCookie } from "@/lib/http";
import { HttpError, ngoCookieValue, ngoMember, SESSION_COOKIE, verifyPassword } from "@/lib/session";

/** Failed attempts per username, so passwords can't be brute-forced quickly. */
const failures = new Map<string, { count: number; since: number }>();
const WINDOW = 10 * 60_000;
const MAX_FAILURES = 8;

/** NGO staff sign-in with username + password. */
export const POST = handle(async (req: Request) => {
  const b = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
  const username = b.username?.trim().toLowerCase() ?? "";
  const password = b.password ?? "";
  if (!username || !password) throw new HttpError(400, "Enter your username and password");

  const f = failures.get(username);
  if (f && Date.now() - f.since < WINDOW && f.count >= MAX_FAILURES) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");

  const db = getDb();
  const m = db.ngos.flatMap((n) => n.members).find((x) => x.username === username);
  // Hash even for unknown users so response time doesn't reveal which usernames exist.
  const ok = verifyPassword(password, m?.passwordHash ?? "00:00") && Boolean(m);
  if (!ok || !m) {
    const cur = f && Date.now() - f.since < WINDOW ? f : { count: 0, since: Date.now() };
    failures.set(username, { ...cur, count: cur.count + 1 });
    mutate((d) => audit(d, { actor: m ? { id: m.id, name: m.name } : { id: "unknown", name: username.slice(0, 40) }, action: "auth.login_failed", summary: m ? "Failed sign-in: wrong password" : "Failed sign-in: unknown username", meta: { attempts: cur.count + 1 } }));
    throw new HttpError(401, "Wrong username or password");
  }
  if (!m.active) {
    mutate((d) => audit(d, { actor: { id: m.id, name: m.name }, action: "auth.login_failed", summary: "Sign-in refused: account is deactivated" }));
    throw new HttpError(403, "This account has been deactivated. Ask an NGO admin to reactivate it.");
  }
  failures.delete(username);
  mutate((d) => audit(d, { actor: { id: m.id, name: m.name }, action: "auth.login", summary: `Signed in (${roleLabel(m.role)})` }));
  return setCookie(json({ ok: true, member: ngoMember(m.id) }), SESSION_COOKIE, ngoCookieValue(m));
});
