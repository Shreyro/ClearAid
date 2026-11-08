import { audit } from "@/lib/audit";
import { controlsOf, rescanUntagged } from "@/lib/banking";
import { getDb, mutate, nowIso } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { fmt, toCents } from "@/lib/money";
import { actorOf, HttpError, requireNgo, requireNgoAdmin } from "@/lib/session";
import { CATEGORIES, type Category, type NgoControls } from "@/lib/types";
import { announce } from "../../bank/shared";

/** The NGO's tracking controls: approval threshold, receipt threshold and fee policy. */
export const GET = handle(async () => {
  const me = await requireNgo();
  const db = getDb();
  const c = controlsOf(db, me.ngoId);
  return json({
    controls: c,
    feeFund: c.feePolicy.fundId ? (db.funds.find((f) => f.id === c.feePolicy.fundId)?.title ?? null) : null,
    unallocatedFees: db.bankTxns.filter((t) => t.status === "fee_unallocated" && db.bankAccounts.some((a) => a.id === t.accountId && a.ngoId === me.ngoId)).length,
  });
});

type Body = {
  tagApprovalThresholdUsd?: number;
  receiptThresholdUsd?: number;
  feePolicy?: { mode: "unallocated" | "fund"; fundId?: string; category?: string };
  /** Also charge fees already waiting in "Bank fees" under the new policy. */
  applyToExistingFees?: boolean;
};

/** Change the controls (admins). Audited; the fee policy applies to fees imported from now on unless asked to re-apply. */
export const POST = handle(async (req: Request) => {
  const admin = await requireNgoAdmin();
  const b = (await req.json()) as Body;
  const res = mutate((db) => {
    const ngo = db.ngos.find((n) => n.id === admin.ngoId)!;
    const before = controlsOf(db, admin.ngoId);
    const next: NgoControls = { ...before, feePolicy: { ...before.feePolicy } };
    if (b.tagApprovalThresholdUsd != null) {
      const v = toCents(b.tagApprovalThresholdUsd);
      if (!(v >= 0) || v > 1e10) throw new HttpError(400, "Approval threshold must be zero or more");
      next.tagApprovalThreshold = v;
    }
    if (b.receiptThresholdUsd != null) {
      const v = toCents(b.receiptThresholdUsd);
      if (!(v >= 0) || v > 1e10) throw new HttpError(400, "Receipt threshold must be zero or more");
      next.receiptThreshold = v;
    }
    if (b.feePolicy) {
      if (b.feePolicy.mode === "fund") {
        const fund = db.funds.find((f) => f.id === b.feePolicy!.fundId && f.ngoId === admin.ngoId);
        if (!fund) throw new HttpError(400, "Choose the fund that pays bank fees");
        if (fund.status === "closed") throw new HttpError(400, `${fund.title} is closed`);
        const category = (CATEGORIES.find((c) => c.id === b.feePolicy!.category)?.id ?? "admin") as Category;
        next.feePolicy = { mode: "fund", fundId: fund.id, category };
      } else next.feePolicy = { mode: "unallocated" };
    }
    next.updatedAt = nowIso();
    next.updatedBy = admin.name;
    ngo.controls = next;

    const changes: string[] = [];
    if (next.tagApprovalThreshold !== before.tagApprovalThreshold) changes.push(`second-person sign-off from ${fmt(before.tagApprovalThreshold)} to ${fmt(next.tagApprovalThreshold)}`);
    if (next.receiptThreshold !== before.receiptThreshold) changes.push(`receipt expected from ${fmt(before.receiptThreshold)} to ${fmt(next.receiptThreshold)}`);
    const feeText = (p: NgoControls["feePolicy"]) => (p.mode === "fund" ? `charged to ${db.funds.find((f) => f.id === p.fundId)?.title} (${CATEGORIES.find((c) => c.id === p.category)?.label})` : "left unallocated");
    if (feeText(next.feePolicy) !== feeText(before.feePolicy)) changes.push(`bank fees ${feeText(before.feePolicy)} → ${feeText(next.feePolicy)}`);
    const scan = b.applyToExistingFees && next.feePolicy.mode === "fund" ? rescanUntagged(db, admin.ngoId, { feesOnly: true }) : { tagged: 0, entries: [] };
    if (!changes.length && !scan.tagged) throw new HttpError(400, "No change");
    audit(db, {
      actor: actorOf(admin),
      action: "ngo.controls_updated",
      summary: `Changed tracking controls: ${changes.join("; ") || "no setting changed"}${scan.tagged ? `. Applied the fee policy to ${scan.tagged} waiting fee(s)` : ""}`,
    });
    return { scan, changes };
  });
  announce(res.scan.entries);
  return json({ ok: true, message: `Saved${res.scan.tagged ? ` · ${res.scan.tagged} waiting fee(s) charged under the new policy` : ""}` });
});
