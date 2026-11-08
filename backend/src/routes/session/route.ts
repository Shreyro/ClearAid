import { getDb } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { DEMO_LOGINS } from "@/lib/seed";
import { findMember, getSession, ngoMember } from "@/lib/session";

/** Who is signed in. Signed-out visitors also get the demo logins for the sign-in page. */
export const GET = handle(async () => {
  const db = getDb();
  const session = await getSession();
  const member = session.role === "ngo" ? ngoMember(session.id) : null;
  return json({
    session: { ...session, name: member?.name, member },
    // Only listed while each account still uses its demo password.
    demoLogins: DEMO_LOGINS.flatMap((l) => {
      const found = findMember(db, l.memberId);
      if (!found?.member.active || found.member.username !== l.username || found.member.passwordChangedAt) return [];
      const m = found.member;
      return [{ username: l.username, password: l.password, name: m.name, title: m.title, role: m.role, note: l.note }];
    }),
  });
});
