import { audit } from "@/lib/audit";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { publish } from "@/lib/events";
import { requiredApprovals } from "@/lib/funds";
import { handle, json } from "@/lib/http";
import { activeAssignees, findMember, HttpError, isAssigned, requireNgo, requireNgoAdmin } from "@/lib/session";
import type { DB, Fund } from "@/lib/types";

/** Why a fund can't clear its withdrawals with the people on it, or null if it can. */
function coverage(db: DB, f: Fund) {
  const approvers = activeAssignees(db, f).length;
  const pending = db.withdrawals.filter((w) => w.fundId === f.id && (w.status === "pending_approval" || w.status === "payout_failed"));
  const blocked = pending.filter((w) => requiredApprovals(f, w) > approvers).length;
  let gap: string | null = null;
  if (f.status !== "closed") {
    if (approvers === 0) gap = "Nobody is assigned, so no withdrawals can be approved";
    else if (approvers < 2) gap = `Only one approver. Withdrawals of $${(f.policy.dualApprovalThreshold / 100).toLocaleString()} or more need a second person assigned`;
  }
  return { approvers, blockedWithdrawals: blocked, gap };
}

const requestView = (db: DB, r: DB["assignmentRequests"][number]) => {
  const fund = db.funds.find((f) => f.id === r.fundId);
  return {
    id: r.id,
    fundId: r.fundId,
    fundTitle: fund?.title ?? "Unknown fund",
    member: { id: r.memberId, name: findMember(db, r.memberId)?.member.name ?? "Former member" },
    note: r.note,
    status: r.status,
    createdAt: r.createdAt,
    decidedBy: r.decidedBy ? (findMember(db, r.decidedBy)?.member.name ?? "An admin") : undefined,
    decidedAt: r.decidedAt,
  };
};

/** Who is on which fund, gaps in approver coverage, and assignment requests. */
export const GET = handle(async () => {
  const me = await requireNgo();
  const db = getDb();
  const funds = db.funds
    .filter((f) => f.ngoId === me.ngoId)
    .map((f) => ({
      id: f.id,
      slug: f.slug,
      title: f.title,
      status: f.status,
      dualApprovalThreshold: f.policy.dualApprovalThreshold,
      assignees: activeAssignees(db, f).map((m) => ({ id: m.id, name: m.name, title: m.title, role: m.role })),
      youAreAssigned: isAssigned(f, me.id),
      yourPendingRequest: db.assignmentRequests.find((r) => r.fundId === f.id && r.memberId === me.id && r.status === "pending")?.id ?? null,
      ...coverage(db, f),
    }));
  const fundIds = new Set(funds.map((f) => f.id));
  const requests = db.assignmentRequests
    .filter((r) => fundIds.has(r.fundId) && (me.role === "admin" || r.memberId === me.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 30)
    .map((r) => requestView(db, r));
  return json({ funds, requests });
});

type Body =
  | { action: "assign" | "unassign"; fundId?: string; memberId?: string }
  | { action: "request"; fundId?: string; note?: string }
  | { action: "decide"; requestId?: string; decision?: "approve" | "decline" }
  | { action: "cancel"; requestId?: string };

export const POST = handle(async (req: Request) => {
  const b = (await req.json()) as Body;
  const me = b.action === "request" || b.action === "cancel" ? await requireNgo() : await requireNgoAdmin();

  const out = mutate((db) => {
    const fundOf = (id?: string) => {
      const f = db.funds.find((x) => x.id === id && x.ngoId === me.ngoId);
      if (!f) throw new HttpError(404, "Unknown fund");
      return f;
    };
    const closePending = (fundId: string, memberId: string, status: "approved" | "cancelled") => {
      for (const r of db.assignmentRequests) if (r.fundId === fundId && r.memberId === memberId && r.status === "pending") Object.assign(r, { status, decidedBy: me.id, decidedAt: nowIso() });
    };

    switch (b.action) {
      case "assign": {
        const f = fundOf(b.fundId);
        const found = findMember(db, b.memberId);
        if (!found || found.ngo.id !== me.ngoId) throw new HttpError(404, "Unknown team member");
        if (!found.member.active) throw new HttpError(400, `${found.member.name}'s account is deactivated`);
        if (found.member.role === "donor") throw new HttpError(400, `${found.member.name} has a read-only donor login and can't be an approver`);
        if (f.status === "closed") throw new HttpError(400, "This fund is closed");
        if (!f.assignees.includes(found.member.id)) {
          f.assignees.push(found.member.id);
          audit(db, { actor: me, action: "assignment.added", fundId: f.id, targetId: found.member.id, summary: `Assigned ${found.member.name} as an approver on ${f.title}` });
        }
        closePending(f.id, found.member.id, "approved");
        return { ok: true, fundId: f.id, message: `${found.member.name} can now sign ${f.title} withdrawals` };
      }
      case "unassign": {
        const f = fundOf(b.fundId);
        if (f.assignees.includes(b.memberId ?? "")) {
          const who = findMember(db, b.memberId)?.member.name ?? "a member";
          audit(db, { actor: me, action: "assignment.removed", fundId: f.id, targetId: b.memberId, summary: `Removed ${who} as an approver on ${f.title}`, meta: { approversLeft: f.assignees.length - 1 } });
        }
        f.assignees = f.assignees.filter((id) => id !== b.memberId);
        return { ok: true, fundId: f.id, message: "Removed from the fund" };
      }
      case "request": {
        const f = fundOf(b.fundId);
        if (f.status === "closed") throw new HttpError(400, "This fund is closed");
        if (isAssigned(f, me.id)) throw new HttpError(400, "You're already assigned to this fund");
        if (db.assignmentRequests.some((r) => r.fundId === f.id && r.memberId === me.id && r.status === "pending")) throw new HttpError(409, "You've already asked to join this fund");
        const id = newId("areq");
        db.assignmentRequests.push({ id, fundId: f.id, memberId: me.id, note: b.note?.trim().slice(0, 300) || undefined, status: "pending", createdAt: nowIso() });
        audit(db, { actor: me, action: "assignment.requested", fundId: f.id, targetId: id, summary: `Asked to be assigned to ${f.title}` });
        return { ok: true, fundId: f.id, message: "Request sent. An admin needs to approve it." };
      }
      case "decide": {
        const r = db.assignmentRequests.find((x) => x.id === b.requestId);
        if (!r || r.status !== "pending") throw new HttpError(404, "That request is no longer open");
        const f = fundOf(r.fundId);
        // The whole point: someone other than the requester signs off.
        if (r.memberId === me.id) throw new HttpError(403, "Someone else has to approve your own request");
        if (b.decision !== "approve" && b.decision !== "decline") throw new HttpError(400, "Decision must be approve or decline");
        const who = findMember(db, r.memberId)?.member;
        if (b.decision === "approve") {
          if (!who?.active) throw new HttpError(400, "That account is deactivated");
          if (!f.assignees.includes(r.memberId)) f.assignees.push(r.memberId);
        }
        Object.assign(r, { status: b.decision === "approve" ? "approved" : "declined", decidedBy: me.id, decidedAt: nowIso() });
        audit(db, { actor: me, action: b.decision === "approve" ? "assignment.approved" : "assignment.declined", fundId: f.id, targetId: r.id, summary: `${b.decision === "approve" ? "Approved" : "Declined"} ${who?.name ?? "a member"}'s request to join ${f.title}` });
        return { ok: true, fundId: f.id, message: b.decision === "approve" ? `${who?.name} is now assigned to ${f.title}` : "Request declined" };
      }
      case "cancel": {
        const r = db.assignmentRequests.find((x) => x.id === b.requestId);
        if (!r || r.status !== "pending" || r.memberId !== me.id) throw new HttpError(404, "That request is no longer open");
        Object.assign(r, { status: "cancelled", decidedBy: me.id, decidedAt: nowIso() });
        audit(db, { actor: me, action: "assignment.cancelled", fundId: r.fundId, targetId: r.id, summary: `Withdrew own request to join ${fundOf(r.fundId).title}` });
        return { ok: true, fundId: r.fundId, message: "Request withdrawn" };
      }
      default:
        throw new HttpError(400, "Unknown action");
    }
  });
  publish({ kind: "team", fundId: out.fundId });
  return json(out);
});
