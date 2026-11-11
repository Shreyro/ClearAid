import { audit, verifyAuditChain } from "@/lib/audit";
import { getDb, mutate, nowIso } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { actorOf, isAssigned, requireNgo } from "@/lib/session";
import type { AuditEntry, DB, MemberRole } from "@/lib/types";

/**
 * Admins see the whole audit trail. Staff see entries for the funds they're
 * assigned to, plus their own actions (sign-ins, requests).
 */
function canSee(db: DB, me: { id: string; role: MemberRole }, e: AuditEntry) {
  if (me.role === "admin") return true;
  if (e.actorId === me.id) return true;
  if (!e.fundId) return false;
  const fund = db.funds.find((f) => f.id === e.fundId);
  return Boolean(fund && isAssigned(fund, me.id));
}

const csvCell = (v: unknown) => {
  if (typeof v === "number") return String(v);
  const s = v === undefined || v === null ? "" : String(v);
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

export const GET = handle(async (req: Request) => {
  const me = await requireNgo();
  const db = getDb();
  const q = new URL(req.url).searchParams;
  const category = q.get("category"); // e.g. "auth", "withdrawal"
  const fund = q.get("fund");
  const actor = q.get("actor");
  const text = q.get("q")?.toLowerCase().trim();
  const from = q.get("from") ? Date.parse(q.get("from")!) : null;
  const to = q.get("to") ? Date.parse(q.get("to")!) + 86400_000 : null;
  const titles = new Map(db.funds.map((f) => [f.id, f.title]));

  const rows = db.auditLog
    .filter((e) => canSee(db, me, e))
    .filter((e) => !category || e.action.startsWith(`${category}.`))
    .filter((e) => !fund || e.fundId === fund)
    .filter((e) => !actor || e.actorId === actor)
    .filter((e) => (from === null || Date.parse(e.ts) >= from) && (to === null || Date.parse(e.ts) < to))
    .filter((e) => !text || [e.summary, e.actorName, e.action, e.fundId && titles.get(e.fundId)].some((v) => v?.toLowerCase().includes(text)))
    .reverse()
    .map((e) => ({ ...e, fundTitle: e.fundId ? titles.get(e.fundId) : undefined }));

  if (q.get("format") === "csv") {
    mutate((d) => audit(d, { actor: actorOf(me), action: "export.audit", summary: `Exported ${rows.length} audit log entries to CSV` }));
    const head = ["Seq", "Time (UTC)", "Actor", "Actor ID", "Action", "Fund", "Target", "Summary", "Details", "Previous hash", "Entry hash"];
    const body = rows.map((e) => [e.seq, e.ts, e.actorName, e.actorId, e.action, e.fundTitle, e.targetId, e.summary, e.meta ? JSON.stringify(e.meta) : "", e.prevHash, e.hash].map(csvCell).join(","));
    return new Response([head.map(csvCell).join(","), ...body].join("\r\n"), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="clearaid-audit-log-${nowIso().slice(0, 10)}.csv"` },
    });
  }

  // Integrity of the whole chain is checked server-side; only admins get the full chain to re-verify in the browser.
  const chain = verifyAuditChain(db.auditLog);
  return json({
    entries: rows.slice(0, 1000),
    total: rows.length,
    chain,
    full: me.role === "admin" && q.get("chain") === "1" ? db.auditLog : undefined,
    actors: [...new Map(db.auditLog.filter((e) => canSee(db, me, e)).map((e) => [e.actorId, e.actorName])).entries()].map(([id, name]) => ({ id, name })),
  });
});
