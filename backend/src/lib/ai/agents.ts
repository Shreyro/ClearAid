import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";
import type Anthropic from "@anthropic-ai/sdk";
import { aiEnabled, config, paypalLive } from "../config";
import { getDb, mutate, nowIso } from "../db";
import { appendLedger } from "../ledger";
import { donationAvailable, donorLabel, findFund, payWithdrawal, requiredApprovals } from "../funds";
import { publish } from "../events";
import { fmt, toCents } from "../money";
import { listRecentTransactions, refundCapture } from "../paypal";
import { activeAssignees, HttpError, isAssigned } from "../session";
import { audit } from "../audit";
import type { Fund, Withdrawal } from "../types";
import { agentTurn, type AgentTool, type AgentTurn } from "./agent";
import { fundOverview, readTools, trackerTools } from "./tools";

// ------------------------------------------------------------ Ask ClearAid ----

const DONOR_SYSTEM = `You are "Ask ClearAid", the assistant on a public disaster-relief transparency site. Donors ask where their money went.

Answer only from tool results; if the data does not say, say so. Lead with the direct answer and the numbers, then the evidence. Mention withdrawal IDs (like wd_ab12cd34ef56) when you refer to specific payments so the reader can click through. Explain audit checks in plain language when relevant.

All records you see are already PII-redacted; never speculate about the identity of beneficiaries. You cannot move money. If a donor asks for a refund, explain that leftover funds are returned or carried forward according to their choice when a fund closes (on their "My impact" page). Keep answers under 180 words and use short paragraphs or bullets.`;

export async function askClearAid(args: { owner: string; fundId: string; donorId?: string; message: string; conversationId?: string }): Promise<AgentTurn> {
  if (!aiEnabled()) {
    const o = fundOverview(getDb(), args.fundId);
    return {
      conversationId: "offline",
      trace: [],
      reply: `AI answers are not configured (set ANTHROPIC_API_KEY). Here are the facts: ${o.title} has raised $${o.raisedUsd.toLocaleString()} from ${o.donors} donors, spent $${o.spentUsd.toLocaleString()} through verified vendors and holds $${o.balanceUsd.toLocaleString()}. Spending by category: ${Object.entries(o.spendByCategoryUsd)
        .map(([k, v]) => `${k} $${v.toLocaleString()}`)
        .join(", ")}.`,
    };
  }
  const fund = findFund(getDb(), args.fundId)!;
  return agentTurn({
    owner: args.owner,
    system: `${DONOR_SYSTEM}\n\nThe reader is on the page for fund "${fund.title}" (id ${fund.id}).${args.donorId ? " They are signed in as a donor; use get_my_impact for questions about their own gift." : " They are not signed in."}`,
    tools: readTools({ donorId: args.donorId, includePending: false }),
    conversationId: args.conversationId,
    userMessage: args.message,
    effort: "low",
  });
}

// ------------------------------------------------------------- NGO Copilot ----

const PAYPAL_ACTIONS = {
  transactions: { list: true },
  payments: { createRefund: true, getRefunds: true },
  disputes: { list: true, get: true },
  insights: { get: true },
};
const GATED = new Set(["create_refund"]);

let toolkit: PayPalAgentToolkit | null = null;
function paypalToolkit() {
  toolkit ??= new PayPalAgentToolkit({
    clientId: config.paypal.clientId || "demo",
    clientSecret: config.paypal.clientSecret || "demo",
    configuration: { actions: PAYPAL_ACTIONS, context: { sandbox: config.paypal.env !== "live" } },
  });
  return toolkit;
}

function cleanSchema(s: Record<string, unknown>): Anthropic.Beta.BetaTool["input_schema"] {
  const rest = Object.fromEntries(Object.entries(s).filter(([k]) => k !== "$schema" && k !== "definitions"));
  return { type: "object", ...rest } as Anthropic.Beta.BetaTool["input_schema"];
}

/** Record a refund that was made outside fund closure (e.g. by the copilot) on the public ledger. */
function guardRefund(captureId: string, amount: number | undefined) {
  const db = getDb();
  const cap = db.captures.find((c) => c.id === captureId);
  if (!cap) throw new Error("This capture is not a ClearAid donation; refuse to refund it from here.");
  const donation = db.donations.find((d) => d.captureIds.includes(captureId) && d.source === "paypal")!;
  const unspent = Math.min(donationAvailable(donation), cap.amount - cap.refunded);
  const amt = amount ?? unspent;
  if (amt > unspent)
    throw new Error(`Only ${fmt(unspent)} of this gift is unspent; ${fmt(amt)} would overdraw the fund. Offer ${fmt(unspent)} instead.`);
  if (amt <= 0) throw new Error("Nothing left to refund on this capture.");
  return { cap, donation, amt };
}

function recordRefund(captureId: string, amt: number, refundId: string, by: { id: string; name: string }) {
  const entry = mutate((db) => {
    const cap = db.captures.find((c) => c.id === captureId)!;
    const donation = db.donations.find((d) => d.captureIds.includes(captureId) && d.source === "paypal")!;
    cap.refunded += amt;
    donation.refunded += amt;
    return appendLedger(db, {
      fundId: donation.fundId,
      type: "refund",
      amount: -amt,
      memo: "Refund issued by NGO staff via ClearAid Copilot",
      actor: donorLabel(db.donors.find((d) => d.id === donation.donorId)),
      paypalRef: refundId,
    });
  });
  mutate((db) => audit(db, { actor: by, action: "refund.issued", fundId: entry.fundId, targetId: captureId, summary: `Refunded ${fmt(amt)} to a donor via the Copilot (PayPal ${refundId})`, meta: { amount: amt, refundId } }));
  publish({ kind: "ledger", fundId: entry.fundId, entry });
}

function simulatedPayPal(name: string, input: Record<string, unknown>) {
  const db = getDb();
  switch (name) {
    case "list_transactions":
      return {
        simulated: true,
        transaction_details: db.captures.slice(-50).map((c) => ({
          transaction_info: {
            transaction_id: c.id,
            transaction_event_code: "T0006",
            transaction_initiation_date: c.createdAt,
            transaction_amount: { currency_code: "USD", value: (c.amount / 100).toFixed(2) },
            transaction_status: "S",
            refunded: (c.refunded / 100).toFixed(2),
          },
        })),
      };
    case "get_merchant_insights": {
      const total = db.captures.reduce((a, c) => a + c.amount, 0);
      return { simulated: true, insight_type: input.insight_type, total_sales: fmt(total), transactions: db.captures.length };
    }
    case "list_disputes":
      return { simulated: true, items: [] };
    case "get_dispute":
      throw new Error("Dispute not found (simulated PayPal)");
    case "get_refund":
      return { simulated: true, id: input.refund_id, status: "COMPLETED" };
    default:
      throw new Error(`${name} is not available in demo mode`);
  }
}

function paypalTools(by: { id: string; name: string }): AgentTool[] {
  const tk = paypalToolkit();
  return tk.getTools().map((t) => {
    const name = t.function.name;
    return {
      name,
      description: `[PayPal Agent Toolkit] ${t.function.description ?? name}`,
      input_schema: cleanSchema((t.function.parameters ?? {}) as Record<string, unknown>),
      gated: GATED.has(name),
      run: async (input) => {
        if (name === "create_refund") {
          const value = (input.amount as { value?: string } | undefined)?.value;
          const { cap, amt } = guardRefund(String(input.capture_id), value ? toCents(value) : undefined);
          const r = paypalLive()
            ? JSON.parse(
                await tk.handleToolCall({
                  id: "call",
                  type: "function",
                  function: { name, arguments: JSON.stringify({ ...input, amount: { currency_code: "USD", value: (amt / 100).toFixed(2) } }) },
                }).then((m) => String(m.content)),
              )
            : await refundCapture(cap.id, amt, String(input.note_to_payer ?? "Refund from ClearAid"));
          if (!r?.id) throw new Error(`PayPal did not confirm the refund: ${JSON.stringify(r).slice(0, 300)}`);
          recordRefund(cap.id, amt, r.id, by);
          return { ...r, recordedOnPublicLedger: true, amount: fmt(amt) };
        }
        if (!paypalLive()) return simulatedPayPal(name, input);
        const msg = await tk.handleToolCall({ id: "call", type: "function", function: { name, arguments: JSON.stringify(input) } });
        return String(msg.content);
      },
    };
  });
}

function clearAidOpsTools(): AgentTool[] {
  return [
    {
      name: "reconcile_with_paypal",
      description:
        "Cross-check every donation capture on ClearAid's ledger against PayPal's transaction records for the last 31 days and report anything missing on either side.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const db = getDb();
        const since = Date.now() - 31 * 86400_000;
        const ours = db.captures.filter((c) => Date.parse(c.createdAt) >= since);
        const live = await listRecentTransactions(31).catch((e) => ({ error: (e as Error).message }));
        if (!live || "error" in live) {
          return {
            mode: live ? "live (error)" : "simulated",
            error: live && "error" in live ? live.error : undefined,
            checked: ours.length,
            matched: live ? 0 : ours.length,
            note: live ? "Could not reach PayPal reporting API" : "Demo mode: PayPal is simulated so every capture reconciles.",
          };
        }
        const theirs = new Set(live.transaction_details.map((t) => String(t.transaction_info.transaction_id)));
        const liveOurs = ours.filter((c) => c.live);
        const missing = liveOurs.filter((c) => !theirs.has(c.id));
        const ourIds = new Set(liveOurs.map((c) => c.id));
        const unknownIncoming = live.transaction_details.filter((t) => {
          const amt = Number((t.transaction_info.transaction_amount as { value?: string })?.value ?? 0);
          return amt > 0 && !ourIds.has(String(t.transaction_info.transaction_id));
        });
        return {
          mode: "live",
          checked: liveOurs.length,
          matched: liveOurs.length - missing.length,
          missingInPayPal: missing.map((c) => ({ capture: c.id, usd: c.amount / 100 })),
          paypalIncomingNotOnLedger: unknownIncoming.slice(0, 20).map((t) => t.transaction_info),
          note: "PayPal's reporting API can lag up to 3 hours behind new transactions.",
        };
      },
    },
  ];
}

const NGO_SYSTEM = `You are ClearAid Copilot, an assistant for an NGO finance team using ClearAid to track where relief money comes from and where it goes. ClearAid is an audit tracker: money arrives by PayPal, bank accounts (CSV or Plaid) and staff-recorded receipts; each fund has tracking codes such as #RO1; every movement sits on a hash-chained fund ledger.

You can read funds, money flows, ledger movements and bank lines (untagged, waiting for a second person, missing receipts, unallocated fees), use PayPal Agent Toolkit tools to look at PayPal transactions, disputes, refunds and insights, and reconcile PayPal against the ledger.

Rules:
- Never tag, retag or suggest a tracking code for a bank or PayPal transaction. Tags come only from a code in the record, the admin's fee policy, or a named person with a reason. If asked to tag, point the person to the Untagged page.
- You can't approve tags. A manual tag at or above the threshold, and any retag, needs a second person to approve it on the Untagged page.
- A donor refund moves money, so it pauses for the human to confirm. Propose it with a one-line reason and never claim it happened until the tool result confirms it. Refunds are capped at the donor's unspent share and written to the hash-chained ledger.
- Answer from tool results only. Lead with the answer and the numbers in USD, then the evidence: dates, from → to, fund, and IDs or references. Keep it short and use bullets.`;

function assignedTitles(memberId: string) {
  return getDb()
    .funds.filter((f) => isAssigned(f, memberId))
    .map((f) => `${f.title} (${f.id})`)
    .join(", ");
}

export async function ngoCopilot(args: { admin: { id: string; name: string; role: "admin" | "user"; ngoId: string }; message?: string; conversationId?: string; confirm?: boolean }): Promise<AgentTurn> {
  if (!aiEnabled()) {
    return { conversationId: "offline", trace: [], reply: "Copilot needs an Anthropic API key (ANTHROPIC_API_KEY). Everything it reads is also on the Money flow, Transactions and Untagged pages." };
  }
  return agentTurn({
    owner: `ngo:${args.admin.id}`,
    system: `${NGO_SYSTEM}\n\nSigned-in ${args.admin.role === "admin" ? "NGO admin (sees every fund)" : "NGO staff member"}: ${args.admin.name}. Assigned funds: ${assignedTitles(args.admin.id) || "none yet"}. PayPal mode: ${paypalLive() ? `live ${config.paypal.env}` : "simulated (demo)"}. Today: ${nowIso().slice(0, 10)}.`,
    tools: [...readTools({ includePending: true }), ...trackerTools(args.admin), ...clearAidOpsTools(), ...paypalTools(args.admin)],
    conversationId: args.conversationId,
    userMessage: args.message,
    confirm: args.confirm,
    effort: "medium",
    maxSteps: 10,
  });
}

// ------------------------------------------------- Approval (shared w/ UI) ----

function signedMessage(fund: Fund, w: Withdrawal) {
  const remaining = requiredApprovals(fund, w) - w.approvals.filter((a) => a.decision === "approve").length;
  const others = activeAssignees(getDb(), fund).filter((m) => !w.approvals.some((a) => a.by === m.id));
  if (others.length < remaining) return `Signed. ${remaining} more approval(s) needed, but nobody else is assigned to ${fund.title} yet. An admin needs to assign a second approver.`;
  return `Signed. ${remaining} more approval(s) needed from: ${others.map((m) => m.name).join(", ")}`;
}

export async function decideWithdrawal(withdrawalId: string, admin: { id: string; name: string }, decision: "approve" | "reject", note?: string) {
  const res = mutate((db) => {
    const w = db.withdrawals.find((x) => x.id === withdrawalId);
    if (!w) throw new Error("Unknown withdrawal");
    if (w.status !== "pending_approval" && w.status !== "payout_failed") throw new Error(`Request is ${w.status}`);
    const fund = findFund(db, w.fundId)!;
    if (!isAssigned(fund, admin.id)) throw new HttpError(403, `You're not assigned to ${fund.title}. Only people assigned to a fund can sign its withdrawals.`);
    if (w.approvals.some((a) => a.by === admin.id)) throw new Error("You have already signed this request; a different assigned approver must co-sign");
    w.approvals.push({ by: admin.id, name: admin.name, decision, note, at: nowIso() });
    const sigs = w.approvals.filter((a) => a.decision === "approve").length;
    audit(db, {
      actor: admin,
      action: decision === "reject" ? "withdrawal.rejected" : "withdrawal.signed",
      fundId: fund.id,
      targetId: w.id,
      summary: decision === "reject" ? `Rejected a ${fmt(w.amount)} payment request${note ? `: ${note}` : ""}` : `Signed a ${fmt(w.amount)} payment request (${sigs} of ${requiredApprovals(fund, w)} signatures)`,
      meta: { amount: w.amount, signatures: sigs, required: requiredApprovals(fund, w) },
    });
    if (decision === "reject") {
      w.status = "rejected";
      const vendor = db.vendors.find((v) => v.id === w.vendorId);
      const entry = appendLedger(db, {
        fundId: fund.id,
        type: "withdrawal_rejected",
        amount: 0,
        memo: `Request for ${fmt(w.amount)} rejected after review${note ? `: ${note}` : ""}`,
        actor: vendor?.name ?? "Vendor",
        ref: w.id,
      });
      return { w, fund, entry, pay: false };
    }
    const approvals = w.approvals.filter((a) => a.decision === "approve").length;
    return { w, fund, entry: null, pay: approvals >= requiredApprovals(fund, w) };
  });
  if (res.entry) publish({ kind: "ledger", fundId: res.fund.id, entry: res.entry });
  publish({ kind: "withdrawal", fundId: res.fund.id, withdrawalId, status: res.w.status });
  if (res.pay) await payWithdrawal(withdrawalId, admin.name);
  const w = getDb().withdrawals.find((x) => x.id === withdrawalId)!;
  return {
    status: w.status,
    approvals: w.approvals.length,
    required: requiredApprovals(res.fund, w),
    payout: w.payout,
    message:
      w.status === "paid"
        ? `Paid ${fmt(w.amount)} via PayPal Payouts (batch ${w.payout?.batchId})`
        : w.status === "rejected"
          ? "Rejected and logged on the public ledger"
          : signedMessage(res.fund, w),
  };
}
