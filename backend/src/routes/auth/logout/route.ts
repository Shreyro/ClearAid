import { audit } from "@/lib/audit";
import { mutate } from "@/lib/db";
import { handle, json, setCookie } from "@/lib/http";
import { getSession, ngoMember, SESSION_COOKIE } from "@/lib/session";

export const POST = handle(async () => {
  const s = await getSession();
  const m = s.role === "ngo" ? ngoMember(s.id) : null;
  if (m) mutate((db) => audit(db, { actor: { id: m.id, name: m.name }, action: "auth.logout", summary: "Signed out" }));
  return setCookie(json({ ok: true }), SESSION_COOKIE, null);
});
