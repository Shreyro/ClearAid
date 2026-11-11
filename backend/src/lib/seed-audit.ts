import { AI_ACTOR, audit, SYSTEM_ACTOR, type AuditInput } from "./audit";
import { fmt } from "./money";
import { type DB, roleLabel } from "./types";

/**
 * Build a believable audit history for the demo from the seeded data, so the
 * audit log, controls and activity feed have something to show from minute one.
 * Entries are generated out of order, then sorted and hash-chained.
 */
export function seedAuditLog(db: DB, now: number) {
  const ngo = db.ngos[0];
  const person = (id: string) => {
    const m = ngo.members.find((x) => x.id === id)!;
    return { id: m.id, name: m.name };
  };
  const admin = person("adm_priya");
  const field = person("adm_daniel");
  const iso = (t: number) => new Date(Math.min(t, now - 60_000)).toISOString();
  const out: AuditInput[] = [];

  for (const [i, m] of ngo.members.entries()) {
    out.push({
      actor: m.id === admin.id ? SYSTEM_ACTOR : admin,
      action: "member.created",
      targetId: m.id,
      ts: iso(Date.parse(m.createdAt) + i * 60_000),
      summary: m.id === admin.id ? `Created the first admin login "${m.username}" for ${m.name}` : `Created ${roleLabel(m.role)} login "${m.username}" for ${m.name}`,
      meta: { role: m.role, username: m.username },
    });
  }
  for (const v of db.vendors) {
    const t = Date.parse(v.joinedAt);
    out.push({ actor: admin, action: "vendor.created", targetId: v.id, ts: iso(t), summary: `Registered vendor ${v.name} (${v.paypalEmail}), unverified`, meta: { category: v.category } });
    if (v.verified) out.push({ actor: admin, action: "vendor.verified", targetId: v.id, ts: iso(t + 26 * 3600_000), summary: `Marked ${v.name} as verified (KYB complete) and added them to all funds` });
  }
  for (const f of db.funds) {
    const t = Date.parse(f.startedAt) - 120_000;
    out.push({ actor: admin, action: "fund.created", fundId: f.id, targetId: f.id, ts: iso(t), summary: `Created fund "${f.title}" (goal ${fmt(f.goal)}, dual approval from ${fmt(f.policy.dualApprovalThreshold)}, max single ${fmt(f.policy.maxSingleWithdrawal)})`, meta: { goal: f.goal, dualApproval: f.policy.dualApprovalThreshold } });
    for (const [i, id] of f.assignees.entries()) out.push({ actor: admin, action: "assignment.added", fundId: f.id, targetId: id, ts: iso(t + (i + 1) * 60_000), summary: `Assigned ${person(id).name} as an approver on ${f.title}` });
    if (f.closingStartedAt) out.push({ actor: admin, action: "fund.closing_started", fundId: f.id, targetId: f.id, ts: f.closingStartedAt, summary: `Started closing ${f.title}` });
  }
  for (const w of db.withdrawals) {
    const v = db.vendors.find((x) => x.id === w.vendorId);
    const created = Date.parse(w.createdAt);
    out.push({ actor: field, action: "withdrawal.submitted", fundId: w.fundId, targetId: w.id, ts: iso(created), summary: `Logged a ${fmt(w.amount)} payment request from ${v?.name}`, meta: { amount: w.amount } });
    const sigs: string[] = [];
    for (const a of w.approvals) {
      if (a.by === "ai") {
        out.push({ actor: AI_ACTOR, action: "withdrawal.fast_lane", fundId: w.fundId, targetId: w.id, ts: a.at, summary: `Auto-approved ${fmt(w.amount)} (${a.note ?? "low risk"})`, meta: { amount: w.amount } });
        continue;
      }
      if (a.decision === "approve") sigs.push(a.by);
      out.push({
        actor: { id: a.by, name: a.name },
        action: a.decision === "reject" ? "withdrawal.rejected" : "withdrawal.signed",
        fundId: w.fundId,
        targetId: w.id,
        ts: a.at,
        summary: a.decision === "reject" ? `Rejected a ${fmt(w.amount)} payment request${a.note ? `: ${a.note}` : ""}` : `Signed a ${fmt(w.amount)} payment request (${sigs.length} signature${sigs.length > 1 ? "s" : ""})`,
        meta: { amount: w.amount },
      });
    }
    if (w.status === "paid" && w.paidAt) out.push({ actor: SYSTEM_ACTOR, action: "withdrawal.paid", fundId: w.fundId, targetId: w.id, ts: w.paidAt, summary: `Paid ${fmt(w.amount)} to ${v?.name} via PayPal Payouts (${w.payout?.batchId})`, meta: { amount: w.amount } });
  }
  for (const r of db.assignmentRequests) out.push({ actor: person(r.memberId), action: "assignment.requested", fundId: r.fundId, targetId: r.id, ts: r.createdAt, summary: `Asked to be assigned to ${db.funds.find((f) => f.id === r.fundId)?.title}` });

  for (const a of db.bankAccounts) out.push({ actor: admin, action: "bank.account_added", targetId: a.id, ts: a.createdAt, summary: `Added bank account "${a.name}" (${a.institution}) for CSV statement uploads`, meta: { provider: a.provider } });
  for (const i of db.statementImports) {
    const acc = db.bankAccounts.find((a) => a.id === i.accountId);
    out.push({ actor: person(i.createdBy), action: "bank.imported", targetId: i.id, ts: i.createdAt, summary: `Imported ${i.fileName} into ${acc?.name}: ${i.imported} new (${i.autoTagged} tagged by code, ${i.imported - i.autoTagged} need a tag), ${i.duplicates} already imported`, meta: { rows: i.rows, imported: i.imported, autoTagged: i.autoTagged, duplicates: i.duplicates } });
  }
  for (const t of db.bankTxns.filter((x) => x.tagSource === "manual" && x.taggedBy)) {
    const a = t.allocations[0];
    out.push({ actor: person(t.taggedBy!), action: "bank.tagged", fundId: a?.fundId, targetId: t.id, ts: t.taggedAt!, summary: `Tagged bank payment ${fmt(Math.abs(t.amount))} "${t.description}": ${t.allocations.map((x) => `${fmt(x.amount)} → ${db.funds.find((f) => f.id === x.fundId)?.title}`).join(", ")}. Reason: ${t.reason}`, meta: { amount: Math.abs(t.amount), direction: t.amount >= 0 ? "in" : "out", splits: t.allocations.length } });
  }
  for (const f of db.funds) if (f.trackingCodes.length) out.push({ actor: admin, action: "fund.codes_updated", fundId: f.id, targetId: f.id, ts: iso(Date.parse(f.startedAt) - 60_000), summary: `Tracking codes for ${f.title}: ${f.trackingCodes.map((c) => `#${c}`).join(", ")}` });

  // A little recent access history, including a couple of failed attempts.
  out.push({ actor: { id: "unknown", name: "admin" }, action: "auth.login_failed", ts: iso(now - 20 * 3600_000), summary: "Failed sign-in: unknown username", meta: { attempts: 1 } });
  out.push({ actor: { id: "unknown", name: "admin" }, action: "auth.login_failed", ts: iso(now - 20 * 3600_000 + 40_000), summary: "Failed sign-in: unknown username", meta: { attempts: 2 } });
  out.push({ actor: field, action: "auth.login", ts: iso(now - 9 * 3600_000), summary: "Signed in (staff)" });
  out.push({ actor: person("adm_meera"), action: "auth.login", ts: iso(now - 5.2 * 3600_000), summary: "Signed in (staff)" });
  out.push({ actor: admin, action: "auth.login", ts: iso(now - 3 * 3600_000), summary: "Signed in (admin)" });

  out.sort((a, b) => a.ts!.localeCompare(b.ts!));
  for (const e of out) audit(db, e);
}
