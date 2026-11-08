import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { aiEnabled } from "../config";
import { getDb, mutate, nowIso, uploadsDir } from "../db";
import { AI_ACTOR, audit as appendAudit } from "../audit";
import { ruleChecks, rulesRisk } from "../checks";
import { findFund, payWithdrawal, requiredApprovals } from "../funds";
import { publish } from "../events";
import { fmt } from "../money";
import { categoryLabel, type AuditResult, type StoredFile } from "../types";
import { MODEL, structured } from "./client";

const AuditSchema = z.object({
  receipt: z.object({
    vendorName: z.string().nullable(),
    date: z.string().nullable().describe("Receipt date as YYYY-MM-DD if visible"),
    total: z.number().nullable().describe("Grand total as printed, in the receipt's own currency"),
    currency: z.string().nullable().describe("ISO currency code of the receipt, e.g. USD or INR"),
    totalUsd: z.number().nullable().describe("Grand total converted to USD (approximate if another currency)"),
    lineItems: z.array(
      z.object({ description: z.string(), quantity: z.number().nullable(), amount: z.number().nullable() }),
    ),
    legible: z.boolean(),
    containsPersonalData: z
      .boolean()
      .describe("True if the receipt shows a private individual's name, phone, ID number or home address"),
  }),
  photos: z.array(
    z.object({
      index: z.number().describe("0-based index of the photo in the order provided"),
      depicts: z.string().describe("Short neutral description of what the photo shows"),
      matchesClaim: z.boolean().describe("Does it plausibly show the goods/services claimed?"),
      estimatedQuantity: z.number().nullable().describe("Rough count of the claimed units visible, if countable"),
      containsIdentifiablePeople: z.boolean().describe("Faces or other features that could identify a person"),
      concerns: z.array(z.string()).describe("E.g. looks like a stock image, screenshot, AI-generated, staged, wrong goods"),
    }),
  ),
  checks: z.array(
    z.object({
      label: z.string(),
      status: z.enum(["pass", "warn", "fail"]),
      detail: z.string(),
    }),
  ),
  riskScore: z.number().describe("0 = clearly legitimate, 100 = almost certainly fraudulent or non-compliant"),
  verdict: z.enum(["approve", "needs_review", "reject"]),
  summary: z
    .string()
    .describe("2-3 sentences for the public ledger explaining the verdict. Never include personal data."),
});

const SYSTEM = `You are ClearAid's independent spending auditor for disaster-relief funds. Donors rely on your audit to know that money left the fund for real relief.

For each withdrawal request you receive the request details, the fund's policy, the results of deterministic rule checks, the receipt/invoice, and proof-of-delivery photos.

Work through:
1. Receipt: extract vendor, date, total and line items. Is it legible and internally consistent (line items add up, plausible tax, dated after the crisis began, vendor name matches the requesting vendor)?
2. Amount: does the receipt total (converted to USD if needed) support the requested amount? Small differences under 3% are fine.
3. Prices: are unit prices plausible for relief goods in the affected region? Flag inflated pricing.
4. Photos: do they plausibly show the claimed goods being delivered or stocked, in roughly the claimed quantity? Flag stock photos, screenshots, images of a screen, AI-generated imagery or goods that do not match.
5. Purpose: is the spending consistent with the fund's purpose and category?

Add your own checks (do not repeat the rule checks verbatim). Be calibrated: legitimate, well-documented requests should score below 25 and be approved. Missing or contradictory evidence should be needs_review. Clear fraud signals should be reject. Your output is a recommendation; NGO staff make the final decision.`;

function readFileBlock(f: StoredFile): Anthropic.Beta.BetaContentBlockParam | null {
  const p = path.join(uploadsDir(), f.id);
  if (!fs.existsSync(p)) return null;
  const data = fs.readFileSync(p).toString("base64");
  if (f.mime === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  }
  if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(f.mime)) {
    return {
      type: "image",
      source: { type: "base64", media_type: f.mime as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data },
    };
  }
  return null;
}

export async function auditWithdrawal(withdrawalId: string): Promise<{ audit: AuditResult; receiptPrivate: boolean }> {
  const db = getDb();
  const w = db.withdrawals.find((x) => x.id === withdrawalId)!;
  const fund = findFund(db, w.fundId)!;
  const vendor = db.vendors.find((v) => v.id === w.vendorId);
  const need = fund.needs.find((n) => n.id === w.needId);
  const rules = ruleChecks(db, fund, w);
  const rRisk = rulesRisk(rules);
  const receipts = w.receiptFileIds.map((id) => db.files.find((f) => f.id === id)!).filter(Boolean);
  const photos = w.photoFileIds.map((id) => db.files.find((f) => f.id === id)!).filter(Boolean);

  if (!aiEnabled()) {
    const fails = rules.filter((c) => c.status === "fail").length;
    const risk = Math.min(100, rRisk + 15);
    return { receiptPrivate: false, audit: {
      engine: "heuristic",
      ranAt: nowIso(),
      riskScore: risk,
      verdict: fails ? (risk >= 60 ? "reject" : "needs_review") : "needs_review",
      summary: fails
        ? `Rule checks found ${fails} blocking issue${fails > 1 ? "s" : ""}. Manual review required.`
        : "Rule checks passed. AI receipt and photo analysis is not configured, so a human reviewer should inspect the documents.",
      photos: [],
      checks: [
        ...rules,
        {
          id: "ai_unavailable",
          label: "AI document audit",
          status: "warn",
          detail: "Set ANTHROPIC_API_KEY to enable receipt extraction and photo verification",
          source: "ai",
        },
      ],
    } };
  }

  const ctx = {
    fund: { title: fund.title, disaster: fund.disaster, region: fund.region, crisisStarted: fund.startedAt.slice(0, 10) },
    request: {
      id: w.id,
      vendor: vendor ? { name: vendor.name, location: vendor.location, category: categoryLabel(vendor.category) } : null,
      amountUsd: w.amount / 100,
      category: categoryLabel(w.category),
      purpose: w.purposePublic,
      need: need ? { item: need.item, unit: need.unit, expectedUnitCostUsd: need.unitCost / 100 } : null,
      quantityClaimed: w.quantity ?? null,
      beneficiariesClaimed: w.beneficiaries ?? null,
      deliveryLocation: w.location ?? null,
      submittedAt: w.createdAt,
    },
    policy: {
      maxSingleWithdrawalUsd: fund.policy.maxSingleWithdrawal / 100,
      categoryCapPct: fund.policy.categoryCaps[w.category] ?? null,
    },
    ruleChecks: rules.map(({ label, status, detail }) => ({ label, status, detail })),
    photoMetadata: photos.map((p, i) => ({ index: i, exif: p.exif ?? null })),
  };

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  receipts.forEach((r, i) => {
    const block = readFileBlock(r);
    if (block) content.push({ type: "text", text: `Receipt ${i + 1} (${r.name}):` }, block);
  });
  photos.forEach((p, i) => {
    const block = readFileBlock(p);
    if (block) content.push({ type: "text", text: `Proof photo index ${i} (${p.name}):` }, block);
  });
  content.push({ type: "text", text: `Withdrawal request context:\n${JSON.stringify(ctx, null, 2)}\n\nAudit this request.` });

  const out = await structured({ schema: AuditSchema, system: SYSTEM, content, effort: "medium", maxTokens: 12000 });

  const hardFail = rules.some((c) => c.status === "fail");
  const risk = Math.round(Math.min(100, Math.max(out.riskScore, rRisk)));
  let verdict = out.verdict;
  if (hardFail && verdict === "approve") verdict = "needs_review";

  const audit: AuditResult = {
    engine: "claude",
    model: MODEL(),
    ranAt: nowIso(),
    riskScore: risk,
    verdict,
    summary: out.summary,
    receipt: {
      vendorName: out.receipt.vendorName,
      date: out.receipt.date,
      total: out.receipt.total,
      currency: out.receipt.currency,
      lineItems: out.receipt.lineItems,
      legible: out.receipt.legible,
    },
    photos: out.photos
      .filter((p) => photos[p.index])
      .map((p) => ({
        fileId: photos[p.index].id,
        depicts: p.depicts,
        matchesClaim: p.matchesClaim,
        estimatedQuantity: p.estimatedQuantity,
        containsIdentifiablePeople: p.containsIdentifiablePeople,
        concerns: p.concerns,
      })),
    checks: [
      ...rules,
      ...out.checks.map((c, i) => ({ id: `ai_${i}`, label: c.label, status: c.status, detail: c.detail, source: "ai" as const })),
      {
        id: "ai_receipt_match",
        label: "Receipt supports amount",
        status:
          out.receipt.totalUsd == null
            ? "warn"
            : Math.abs(out.receipt.totalUsd * 100 - w.amount) / w.amount <= 0.03
              ? "pass"
              : out.receipt.totalUsd * 100 < w.amount
                ? "fail"
                : "warn",
        detail:
          out.receipt.totalUsd == null
            ? "Could not read a total from the receipt"
            : `Receipt total ≈ ${fmt(Math.round(out.receipt.totalUsd * 100))} vs ${fmt(w.amount)} requested`,
        source: "ai",
      },
    ],
  };
  return { audit, receiptPrivate: out.receipt.containsPersonalData };
}

/** Run the audit, store results, apply privacy rules and the AI fast lane. */
export async function runAudit(withdrawalId: string) {
  let audit: AuditResult;
  let receiptPrivate = false;
  try {
    ({ audit, receiptPrivate } = await auditWithdrawal(withdrawalId));
  } catch (e) {
    const db = getDb();
    const w = db.withdrawals.find((x) => x.id === withdrawalId)!;
    const fund = findFund(db, w.fundId)!;
    const rules = ruleChecks(db, fund, w);
    audit = {
      engine: "heuristic",
      ranAt: nowIso(),
      riskScore: Math.min(100, rulesRisk(rules) + 20),
      verdict: "needs_review",
      summary: `AI audit failed (${(e as Error).message}). Rule checks shown; manual review required.`,
      photos: [],
      checks: rules,
    };
  }

  const { fundId, autoPay } = mutate((db) => {
    const w = db.withdrawals.find((x) => x.id === withdrawalId)!;
    const fund = findFund(db, w.fundId)!;
    w.audit = audit;
    w.status = "pending_approval";
    for (const p of audit.photos) {
      const f = db.files.find((x) => x.id === p.fileId);
      if (f && p.containsIdentifiablePeople) f.public = false; // dignity: faces stay private
    }
    if (receiptPrivate) {
      for (const id of w.receiptFileIds) {
        const f = db.files.find((x) => x.id === id);
        if (f) f.public = false;
      }
    }

    const p = fund.policy;
    const clean = !audit.checks.some((c) => c.status === "fail");
    const fast =
      p.fastLaneMax > 0 &&
      w.amount <= p.fastLaneMax &&
      audit.engine === "claude" &&
      audit.verdict === "approve" &&
      audit.riskScore <= p.fastLaneMaxRisk &&
      clean &&
      requiredApprovals(fund, w) === 1;
    if (fast) {
      w.approvals.push({ by: "ai", name: "ClearAid AI fast lane", decision: "approve", note: `Risk ${audit.riskScore}/100, under ${fmt(p.fastLaneMax)}`, at: nowIso() });
      appendAudit(db, { actor: AI_ACTOR, action: "withdrawal.fast_lane", fundId: fund.id, targetId: w.id, summary: `Auto-approved ${fmt(w.amount)} (risk ${audit.riskScore}/100, under the ${fmt(p.fastLaneMax)} fast-lane limit)`, meta: { amount: w.amount, risk: audit.riskScore } });
    }
    return { fundId: fund.id, autoPay: fast };
  });
  publish({ kind: "withdrawal", fundId, withdrawalId, status: "pending_approval" });
  if (autoPay) await payWithdrawal(withdrawalId, "ClearAid AI fast lane").catch(() => undefined);
}
