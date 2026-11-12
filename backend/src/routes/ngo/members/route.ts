import { audit } from "@/lib/audit";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { publish } from "@/lib/events";
import { handle, json, setCookie } from "@/lib/http";
import { findMember, hashPassword, HttpError, ngoCookieValue, requireNgo, requireNgoAdmin, SESSION_COOKIE } from "@/lib/session";
import { type DB, type MemberRole, type Ngo, roleLabel } from "@/lib/types";

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
      // May send PayPal payments: admins always, staff when an admin allowed it.
      canPay: m.role === "admin" || (m.role === "user" && Boolean(m.canPay)),
      // Donors: the funds an admin lets them see.
      viewFundIds: m.role === "donor" ? funds.filter((f) => f.viewers?.includes(m.id)).map((f) => f.id) : undefined,
    })),
  });
});

type Body =
  | { action: "create"; name?: string; title?: string; username?: string; password?: string; role?: MemberRole }
  | { action: "update"; id?: string; title?: string; role?: MemberRole; active?: boolean; password?: string; canPay?: boolean }
  | { action: "donor_funds"; id?: string; fundIds?: string[] };

/** Admins create staff logins and manage existing ones. */
export const POST = handle(async (req: Request) => {
  const me = await requireNgoAdmin();
  const b = (await req.json()) as Body;
  const checkPassword = (p?: string) => {
    if (!p || p.length < MIN_PASSWORD) throw new HttpError(400, `Passwords need at least ${MIN_PASSWORD} characters`);
    return p;
  };
  const role = (r?: MemberRole): MemberRole | undefined => (r === undefined ? undefined : r === "admin" || r === "user" || r === "donor" ? r : (() => { throw new HttpError(400, "Role must be admin, user or donor"); })());
  /** Donors are read-only, so they can't sit on a fund's approver list or have requests to join one. */
  /** Funds a donor may see. Cleared when they stop being a donor or are deactivated. */
  const dropViewer = (db: DB, memberId: string) => {
    for (const f of db.funds) if (f.viewers?.includes(memberId)) f.viewers = f.viewers.filter((id) => id !== memberId);
  };
  const dropFundAccess = (db: DB, memberId: string) => {
    for (const f of db.funds) f.assignees = f.assignees.filter((id) => id !== memberId);
    for (const r of db.assignmentRequests) if (r.memberId === memberId && r.status === "pending") Object.assign(r, { status: "cancelled", decidedBy: me.id, decidedAt: nowIso() });
  };

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
        title: b.title?.trim().slice(0, 80) || (b.role === "donor" ? "Donor" : "Staff"),
        username,
        passwordHash: hashPassword(checkPassword(b.password)),
        role: role(b.role) ?? "user",
        active: true,
        createdAt: nowIso(),
        createdBy: me.id,
      };
      ngo.members.push(m);
      audit(db, { actor: me, action: "member.created", targetId: m.id, summary: `Created ${roleLabel(m.role)} login "${m.username}" for ${m.name}`, meta: { role: m.role, username: m.username } });
      return { ok: true, id: m.id };
    }

    if (b.action === "donor_funds") {
      const m = ngo.members.find((x) => x.id === b.id);
      if (!m) throw new HttpError(404, "Unknown team member");
      if (m.role !== "donor") throw new HttpError(400, "Only donor logins are given funds to view. Staff are assigned under Funds & access.");
      const want = new Set(b.fundIds ?? []);
      const funds = db.funds.filter((f) => f.ngoId === ngo.id);
      for (const id of want) if (!funds.some((f) => f.id === id)) throw new HttpError(400, "Unknown fund");
      const added: string[] = [];
      const removed: string[] = [];
      for (const f of funds) {
        const has = Boolean(f.viewers?.includes(m.id));
        if (want.has(f.id) && !has) {
          f.viewers = [...(f.viewers ?? []), m.id];
          added.push(f.title);
        } else if (!want.has(f.id) && has) {
          f.viewers = (f.viewers ?? []).filter((x) => x !== m.id);
          removed.push(f.title);
        }
      }
      if (added.length || removed.length) {
        audit(db, {
          actor: me,
          action: "member.donor_funds_changed",
          targetId: m.id,
          summary: `${m.name} (donor) can ${[added.length ? `now see ${added.join(", ")}` : "", removed.length ? `no longer see ${removed.join(", ")}` : ""].filter(Boolean).join("; ")}`,
          meta: { funds: [...want].join(",") },
        });
      }
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
      if (m.role !== nextRole) audit(db, { actor: me, action: "member.role_changed", targetId: m.id, summary: `Changed ${m.name} from ${roleLabel(m.role)} to ${roleLabel(nextRole)}`, meta: { from: m.role, to: nextRole } });
      if (m.role !== nextRole && nextRole === "donor") dropFundAccess(db, m.id);
      // Only staff carry the permission: admins always may pay, donors never.
      if (b.canPay !== undefined || (m.role !== nextRole && nextRole !== "user" && m.canPay)) {
        if (b.canPay !== undefined && nextRole !== "user") throw new HttpError(400, nextRole === "admin" ? "Admins can always send payments" : "Donor logins can't send payments");
        const want = nextRole === "user" ? Boolean(b.canPay) : false;
        if (Boolean(m.canPay) !== want) {
          m.canPay = want || undefined;
          audit(db, { actor: me, action: "member.payments_permission_changed", targetId: m.id, summary: want ? `Allowed ${m.name} to send PayPal payments from the funds they're on` : `${m.name} can no longer send PayPal payments` });
        }
      }
      if (m.role === "donor" && nextRole !== "donor") dropViewer(db, m.id);
      m.role = nextRole;
      if (b.password !== undefined) {
        m.passwordHash = hashPassword(checkPassword(b.password));
        m.passwordChangedAt = nowIso();
        audit(db, { actor: me, action: "member.password_reset", targetId: m.id, summary: m.id === me.id ? "Changed own password" : `Reset ${m.name}'s password (signed out of all sessions)` });
      }
      if (m.active && !nextActive) {
        // A deactivated person comes off every fund and their open requests close.
        dropFundAccess(db, m.id);
        dropViewer(db, m.id);
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
