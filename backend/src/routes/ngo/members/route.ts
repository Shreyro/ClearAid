import { audit } from "@/lib/audit";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { publish } from "@/lib/events";
import { handle, json, setCookie } from "@/lib/http";
import { findMember, hashPassword, HttpError, ngoCookieValue, requireNgo, requireNgoAdmin, SESSION_COOKIE } from "@/lib/session";
import type { DB, MemberRole, Ngo } from "@/lib/types";

const USERNAME = /^[a-z0-9._-]{3,32}$/;
const MIN_PASSWORD = 8;

function ngoOf(db: DB, ngoId: string): Ngo {
  const ngo = db.ngos.find((n) => n.id === ngoId);
  if (!ngo) throw new HttpError(404, "NGO not found");
  return ngo;
}

/** Everyone on the NGO's team, with the funds they're assigned to. */
export const GET = handle(async () => {
  const me = await requireNgo();
  const db = getDb();
  const ngo = ngoOf(db, me.ngoId);
  const funds = db.funds.filter((f) => f.ngoId === ngo.id);
  return json({
    members: ngo.members.map((m) => ({
      id: m.id,
      name: m.name,
      title: m.title,
      role: m.role,
      active: m.active,
      // Usernames are only for admins (they hand out the logins).
      username: me.role === "admin" ? m.username : undefined,
      createdAt: m.createdAt,
      fundIds: funds.filter((f) => f.assignees.includes(m.id)).map((f) => f.id),
    })),
  });
});

type Body =
  | { action: "create"; name?: string; title?: string; username?: string; password?: string; role?: MemberRole }
  | { action: "update"; id?: string; title?: string; role?: MemberRole; active?: boolean; password?: string };

/** Admins create staff logins and manage existing ones. */
export const POST = handle(async (req: Request) => {
  const me = await requireNgoAdmin();
  const b = (await req.json()) as Body;
  const checkPassword = (p?: string) => {
    if (!p || p.length < MIN_PASSWORD) throw new HttpError(400, `Passwords need at least ${MIN_PASSWORD} characters`);
    return p;
  };
  const role = (r?: MemberRole): MemberRole | undefined => (r === undefined ? undefined : r === "admin" || r === "user" ? r : (() => { throw new HttpError(400, "Role must be admin or user"); })());

  const out = mutate((db) => {
    const ngo = ngoOf(db, me.ngoId);
    if (b.action === "create") {
      const name = b.name?.trim();
      const username = b.username?.trim().toLowerCase() ?? "";
      if (!name) throw new HttpError(400, "Enter the person's name");
      if (!USERNAME.test(username)) throw new HttpError(400, "Usernames are 3-32 characters: letters, numbers, dots, dashes or underscores");
      if (db.ngos.some((n) => n.members.some((m) => m.username === username))) throw new HttpError(409, `The username "${username}" is taken`);
      const m = {
        id: newId("mem"),
        name: name.slice(0, 80),
        title: b.title?.trim().slice(0, 80) || "Staff",
        username,
        passwordHash: hashPassword(checkPassword(b.password)),
        role: role(b.role) ?? "user",
        active: true,
        createdAt: nowIso(),
        createdBy: me.id,
      };
      ngo.members.push(m);
      audit(db, { actor: me, action: "member.created", targetId: m.id, summary: `Created ${m.role === "admin" ? "admin" : "staff"} login "${m.username}" for ${m.name}`, meta: { role: m.role, username: m.username } });
      return { ok: true, id: m.id };
    }

    if (b.action === "update") {
      const m = ngo.members.find((x) => x.id === b.id);
      if (!m) throw new HttpError(404, "Unknown team member");
      const nextRole = role(b.role) ?? m.role;
      const nextActive = b.active ?? m.active;
      if (m.id === me.id && (nextRole !== "admin" || !nextActive)) throw new HttpError(400, "You can't remove your own admin access. Ask another admin.");
      const adminsLeft = ngo.members.filter((x) => x.active && x.role === "admin" && (x.id !== m.id || (nextRole === "admin" && nextActive))).length;
      if (adminsLeft === 0) throw new HttpError(400, "The NGO needs at least one active admin");

      if (b.title !== undefined) m.title = b.title.trim().slice(0, 80) || m.title;
      if (m.role !== nextRole) audit(db, { actor: me, action: "member.role_changed", targetId: m.id, summary: `Changed ${m.name} from ${m.role} to ${nextRole}`, meta: { from: m.role, to: nextRole } });
      m.role = nextRole;
      if (b.password !== undefined) {
        m.passwordHash = hashPassword(checkPassword(b.password));
        m.passwordChangedAt = nowIso();
        audit(db, { actor: me, action: "member.password_reset", targetId: m.id, summary: m.id === me.id ? "Changed own password" : `Reset ${m.name}'s password (signed out of all sessions)` });
      }
      if (m.active && !nextActive) {
        // A deactivated person comes off every fund and their open requests close.
        for (const f of db.funds) f.assignees = f.assignees.filter((id) => id !== m.id);
        for (const r of db.assignmentRequests) if (r.memberId === m.id && r.status === "pending") Object.assign(r, { status: "cancelled", decidedBy: me.id, decidedAt: nowIso() });
      }
      if (m.active !== nextActive) audit(db, { actor: me, action: nextActive ? "member.reactivated" : "member.deactivated", targetId: m.id, summary: nextActive ? `Reactivated ${m.name}` : `Deactivated ${m.name} and removed them from all funds` });
      m.active = nextActive;
      return { ok: true, id: m.id };
    }
    throw new HttpError(400, "Unknown action");
  });
  publish({ kind: "team" });
  // Changing your own password re-signs your cookie so you stay signed in here.
  if (b.action === "update" && b.id === me.id && b.password !== undefined) {
    return setCookie(json(out), SESSION_COOKIE, ngoCookieValue(findMember(getDb(), me.id)!.member));
  }
  return json(out);
});
