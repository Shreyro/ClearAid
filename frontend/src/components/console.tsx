"use client";

import Link from "next/link";
import { useState } from "react";
import { BadgeCheck, Building2, KeyRound, Loader2, PenLine, Plus, Sparkles, Trash2, UserPlus, Users, Wand2, X } from "lucide-react";
import clsx from "clsx";
import { api, ago, useJson, useLive, usd } from "@/components/hooks";
import { Empty, Pill, RiskBadge, Section, StatusIcon, StatusPill } from "@/components/ui";
import { CAT_LABEL, type WView } from "@/components/SpendCard";
import { CodesEditor } from "@/components/banking";
import type { PayPalAccount } from "@/components/PayPalAccounts";


export type Role = "admin" | "user" | "donor";
/** How each kind of login is named on screen. */
export const roleName = (r: Role) => (r === "admin" ? "Admin" : r === "donor" ? "Donor" : "Staff");
export type Member = { id: string; name: string; title: string; role: Role; ngoName: string };
export type DemoLogin = { username: string; password: string; name: string; title: string; role: Role; note: string };
export type Sess = { session: { role: string; id?: string; name?: string; member?: Member | null }; demoLogins: DemoLogin[] };

// ---------------------------------------------------------------- Sign in ----

export function SignIn({ demoLogins, onSignedIn }: { demoLogins: DemoLogin[]; onSignedIn: () => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function signIn(u = username, p = password) {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/auth/login", { json: { username: u, password: p } });
      window.dispatchEvent(new Event("clearaid:persona"));
      await onSignedIn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen mx-auto max-w-4xl px-4 py-12 grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-6 items-start content-center">
      <div className="card p-6">
        <Building2 className="h-9 w-9 text-brand" />
        <h1 className="text-2xl font-semibold mt-3">Sign in to ClearAid</h1>
        <p className="text-sm text-ink-2 mt-1">Financial controls for relief NGOs: every transaction on a tamper-evident ledger, AI-audited payouts with dual approval, and a full audit trail. Accounts are created by your NGO&apos;s admin.</p>
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void signIn();
          }}
        >
          <div>
            <label className="label" htmlFor="ngo-user">Username</label>
            <input id="ngo-user" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="ngo-pass">Password</label>
            <input id="ngo-pass" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button className="btn btn-primary w-full" disabled={busy || !username || !password}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Sign in
          </button>
          {err && <p className="text-sm text-critical" role="alert">{err}</p>}
        </form>
      </div>
      {demoLogins.length > 0 && (
        <div>
          <h2 className="font-semibold">Demo logins</h2>
          <p className="text-xs text-muted mt-0.5">Fictional staff of Coastal Relief Collective. Click one to sign in.</p>
          <div className="mt-3 space-y-2">
            {demoLogins.map((l) => (
              <button
                key={l.username}
                className="card p-4 w-full text-left hover:border-brand disabled:opacity-60"
                disabled={busy}
                onClick={() => {
                  setUsername(l.username);
                  setPassword(l.password);
                  void signIn(l.username, l.password);
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{l.name} <span className="font-normal text-muted text-sm">· {l.title}</span></span>
                  <Pill tone={l.role === "admin" ? "brand" : "neutral"}>{roleName(l.role)}</Pill>
                </div>
                <div className="text-xs text-ink-2 mt-1">{l.note}</div>
                <div className="text-xs mt-2 font-mono text-muted">{l.username} / {l.password}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Queue ----

type QueueItem = WView & {
  approvals: (WView["approvals"][number] & { by?: string })[];
  signing?: { youAreAssigned: boolean; approvers: { id: string; name: string }[] };
};

export function Queue({ me, onGoToAccess }: { me: Member; onGoToAccess: () => void }) {
  const { data, reload } = useJson<{ withdrawals: QueueItem[] }>("/api/withdrawals?status=auditing,pending_approval,payout_failed");
  const recent = useJson<{ withdrawals: WView[] }>("/api/withdrawals?status=paid,rejected");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  useLive(undefined, (e) => {
    if (e.kind === "withdrawal" || e.kind === "ledger" || e.kind === "team") {
      void reload();
      void recent.reload();
    }
  });

  async function decide(id: string, decision: "approve" | "reject") {
    setBusy(id + decision);
    try {
      const r = await api<{ message: string }>(`/api/withdrawals/${id}/decision`, { json: { decision, note: decision === "reject" ? "Rejected from review queue" : undefined } });
      setMsg((m) => ({ ...m, [id]: r.message }));
      await reload();
    } catch (e) {
      setMsg((m) => ({ ...m, [id]: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  const items = data?.withdrawals ?? [];
  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-6">
      <div className="space-y-3">
        {!data && <div className="card h-40 animate-pulse" />}
        {data && !items.length && (
          <div className="card">
            <Empty>
              {me.role === "user" ? (
                <>Nothing waiting on your funds. You only see requests for funds you&apos;re assigned to. <button className="underline" onClick={onGoToAccess}>See your funds</button></>
              ) : (
                "Nothing waiting. New payment requests appear here live."
              )}
            </Empty>
          </div>
        )}
        {items.map((w) => {
          const fails = w.audit?.checks.filter((c) => c.status === "fail") ?? [];
          const warns = w.audit?.checks.filter((c) => c.status === "warn") ?? [];
          const mine = w.approvals.some((a) => a.by === me.id);
          const signed = w.approvals.filter((a) => a.decision === "approve").length;
          const assigned = w.signing?.youAreAssigned ?? false;
          // People who could still add a signature (assigned, haven't signed).
          const canStillSign = (w.signing?.approvers ?? []).filter((p) => !w.approvals.some((a) => a.by === p.id)).length;
          const short = w.status !== "auditing" && canStillSign < w.requiredApprovals - signed;
          const blockedReason = !assigned ? "You're not assigned to this fund" : mine ? "You already signed; a different assigned approver must co-sign" : undefined;
          return (
            <div key={w.id} className="card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-muted">{w.fundTitle} · {ago(w.createdAt)}</div>
                  <Link href={`/spend/${w.id}`} className="font-semibold hover:underline">{w.vendor?.name} · {CAT_LABEL[w.category]}</Link>
                </div>
                <div className="text-right">
                  <div className="text-xl font-semibold tnum">{usd(w.amount)}</div>
                  <div className="flex gap-1.5 justify-end mt-1"><StatusPill status={w.status} />{w.audit && w.status !== "auditing" && <RiskBadge score={w.audit.riskScore} verdict={w.audit.verdict} />}</div>
                </div>
              </div>
              <p className="text-sm text-ink-2 mt-2">{w.purpose}</p>
              {w.status === "auditing" ? (
                <div className="mt-3 text-sm text-ink-2 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Redacting personal data and auditing receipt + photos…</div>
              ) : w.audit ? (
                <div className="mt-3 rounded-lg bg-sunken p-3 text-sm">
                  <div className="flex items-start gap-2"><Sparkles className="h-4 w-4 text-brand mt-0.5 shrink-0" /><span>{w.audit.summary}</span></div>
                  {[...fails, ...warns].slice(0, 4).map((c) => (
                    <div key={c.id} className="flex items-start gap-2 mt-1.5 text-xs"><StatusIcon status={c.status} className="h-3.5 w-3.5 mt-0.5" /><span><b>{c.label}:</b> {c.detail}</span></div>
                  ))}
                  {!fails.length && !warns.length && <div className="text-xs text-good-ink mt-1.5">All {w.audit.checks.length} checks passed</div>}
                </div>
              ) : null}
              {short && (
                <div className="mt-3 rounded-lg bg-warn-wash text-warn-ink p-3 text-xs flex flex-wrap items-center gap-2">
                  <Users className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1 min-w-[12rem]">
                    Needs {w.requiredApprovals} signatures, but only {w.signing?.approvers.length ?? 0} {(w.signing?.approvers.length ?? 0) === 1 ? "person is" : "people are"} assigned to this fund. Someone else has to be assigned before it can be paid.
                  </span>
                  <button className="underline font-semibold" onClick={onGoToAccess}>{me.role === "admin" ? "Assign someone" : "Request to join"}</button>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 mt-4">
                <span className="text-xs text-ink-2 mr-auto">
                  Signatures {signed}/{w.requiredApprovals}
                  {w.approvals.map((a) => ` · ${a.name}`).join("")}
                  {w.signing && <span className="text-muted"> · Approvers: {w.signing.approvers.map((p) => p.name).join(", ") || "none"}</span>}
                </span>
                <Link href={`/spend/${w.id}`} className="btn btn-ghost !py-1.5 text-xs">Full audit</Link>
                <button className="btn btn-danger !py-1.5 text-xs" disabled={Boolean(busy) || w.status === "auditing" || Boolean(blockedReason)} title={blockedReason} onClick={() => decide(w.id, "reject")}>Reject</button>
                <button className="btn btn-primary !py-1.5 text-xs" disabled={Boolean(busy) || w.status === "auditing" || Boolean(blockedReason)} title={blockedReason} onClick={() => decide(w.id, "approve")}>
                  {busy === w.id + "approve" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {!assigned ? "Not assigned to this fund" : mine ? "Waiting for co-signer" : signed + 1 >= w.requiredApprovals ? "Approve & pay via PayPal" : "Approve (1st signature)"}
                </button>
              </div>
              {msg[w.id] && <p className="text-xs mt-2 text-ink-2">{msg[w.id]}</p>}
            </div>
          );
        })}
      </div>
      <Section title="Recent decisions">
        <ul className="space-y-2.5 text-sm">
          {(recent.data?.withdrawals ?? []).slice(0, 10).map((w) => (
            <li key={w.id}>
              <Link href={`/spend/${w.id}`} className="flex justify-between gap-2 hover:underline">
                <span className="truncate">{w.vendor?.name}</span>
                <span className={clsx("tnum shrink-0", w.status === "rejected" ? "text-critical line-through" : "")}>{usd(w.amount)}</span>
              </Link>
              <div className="text-xs text-muted">{w.status === "paid" ? `Paid ${ago(w.paidAt!)}` : "Rejected"} · {w.approvals.map((a) => a.name).join(", ")}</div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

// ------------------------------------------------------------------ Funds ----

type FundCard = { id: string; slug: string; title: string; status: string; raised: number; spent: number; balance: number; donors: number; transparency: number; trackingCodes: string[]; bankIn: number; bankOut: number; paypalAccountId: string; donorReturns?: boolean; returnOptIns?: number };
type Draft = { title: string; disaster: string; region: string; description: string; goal: number; lat: number; lng: number; needs: { item: string; category: string; unit: string; targetQty: number; unitCost: number }[]; categoryCaps: Record<string, number>; engine: string };

type AccessFund = {
  id: string;
  slug: string;
  title: string;
  status: string;
  dualApprovalThreshold: number;
  assignees: { id: string; name: string; title: string; role: Role }[];
  youAreAssigned: boolean;
  yourPendingRequest: string | null;
  approvers: number;
  blockedWithdrawals: number;
  gap: string | null;
};
type AccessRequest = { id: string; fundId: string; fundTitle: string; member: { id: string; name: string }; note?: string; status: string; createdAt: string; decidedBy?: string; decidedAt?: string };
type TeamMember = { id: string; name: string; title: string; role: Role; active: boolean; username?: string; createdAt: string; fundIds: string[]; viewFundIds?: string[] };

function useAccess() {
  const access = useJson<{ funds: AccessFund[]; requests: AccessRequest[] }>("/api/ngo/assignments");
  const reload = access.reload;
  useLive(undefined, (e) => {
    if (e.kind === "team" || e.kind === "withdrawal" || e.kind === "fund" || (e.kind === "ledger" && e.entry?.type === "fund_opened")) void reload();
  });
  return access;
}

export function Funds({ me }: { me: Member }) {
  return (
    <div className="space-y-8">
      <Access me={me} />
      {me.role === "admin" && <FundAdmin />}
    </div>
  );
}

export function Access({ me }: { me: Member }) {
  const { data, reload } = useAccess();
  const team = useJson<{ members: TeamMember[] }>(me.role === "admin" ? "/api/ngo/members" : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const isAdmin = me.role === "admin";

  async function act(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setMsg(null);
    try {
      const r = await api<{ message: string }>("/api/ngo/assignments", { json: body });
      setMsg({ text: r.message });
      setAsking(null);
      setNote("");
      await reload();
      await team.reload();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <div className="card h-40 animate-pulse" />;
  const pending = data.requests.filter((r) => r.status === "pending");
  const active = (team.data?.members ?? []).filter((m) => m.active);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{isAdmin ? "Who can see each fund" : "Your fund access"}</h2>
        <p className="text-sm text-ink-2">
          {isAdmin
            ? "Staff see, and can tag bank lines to, only the funds they're assigned to. Admins see every fund. A request to join is approved by someone other than the requester."
            : "You can see and tag money for the funds you're assigned to. To work on another fund, ask to join it and an admin will approve your request."}
        </p>
      </div>
      {msg && <div className={clsx("card p-3 text-sm", msg.bad ? "border-bad-line text-critical" : "bg-brand-wash border-brand-line")}>{msg.text}</div>}

      {isAdmin && pending.length > 0 && (
        <Section title={<span className="flex items-center gap-2">Requests to join a fund <Pill tone="warn">{pending.length} waiting</Pill></span>}>
          <ul className="divide-y divide-line -my-2">
            {pending.map((r) => (
              <li key={r.id} className="py-3 flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[14rem]">
                  <div className="text-sm"><b>{r.member.name}</b> asked to join <b>{r.fundTitle}</b> <span className="text-muted">· {ago(r.createdAt)}</span></div>
                  {r.note && <div className="text-xs text-ink-2 mt-0.5">&ldquo;{r.note}&rdquo;</div>}
                </div>
                {r.member.id === me.id ? (
                  <span className="text-xs text-muted">Another admin has to approve your own request</span>
                ) : (
                  <div className="flex gap-2">
                    <button className="btn btn-ghost !py-1 text-xs" disabled={Boolean(busy)} onClick={() => act(r.id + "d", { action: "decide", requestId: r.id, decision: "decline" })}>Decline</button>
                    <button className="btn btn-primary !py-1 text-xs" disabled={Boolean(busy)} onClick={() => act(r.id + "a", { action: "decide", requestId: r.id, decision: "approve" })}>
                      {busy === r.id + "a" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Approve &amp; assign
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data.funds.map((f) => {
          const addable = active.filter((m) => m.role !== "donor" && !f.assignees.some((a) => a.id === m.id));
          return (
            <div key={f.id} className={clsx("card p-4 flex flex-col gap-3", f.gap && f.status !== "closed" && "border-warn-line")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/funds/${f.slug}`} className="font-semibold hover:underline leading-snug">{f.title}</Link>
                  
                </div>
                <StatusPill status={f.status} />
              </div>

              <div>
                <div className="text-xs uppercase tracking-wide text-muted font-semibold mb-1.5">People with access ({f.approvers})</div>
                <div className="flex flex-wrap gap-1.5">
                  {f.assignees.length === 0 && <span className="text-xs text-muted">Nobody yet</span>}
                  {f.assignees.map((a) => (
                    <span key={a.id} className={clsx("inline-flex items-center gap-1 rounded-full border border-line pl-2.5 pr-1.5 py-0.5 text-xs", a.id === me.id && "bg-brand-wash border-brand-line")}>
                      {a.name}{a.id === me.id && " (you)"}
                      {isAdmin && (
                        <button className="text-muted hover:text-critical rounded-full p-0.5" aria-label={`Remove ${a.name} from ${f.title}`} disabled={Boolean(busy)} onClick={() => act(f.id + a.id, { action: "unassign", fundId: f.id, memberId: a.id })}>
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              </div>

              {f.gap && (
                <div className="rounded-lg bg-warn-wash text-warn-ink p-2.5 text-xs">
                  <b>Needs someone else assigned.</b> {f.gap}.
                  {f.blockedWithdrawals > 0 && <> {f.blockedWithdrawals} pending withdrawal{f.blockedWithdrawals > 1 ? "s are" : " is"} stuck until then.</>}
                </div>
              )}

              <div className="mt-auto">
                {isAdmin && f.status !== "closed" && (
                  <select
                    className="input !py-1.5 text-sm"
                    value=""
                    disabled={Boolean(busy) || addable.length === 0}
                    onChange={(e) => e.target.value && act(f.id + "add", { action: "assign", fundId: f.id, memberId: e.target.value })}
                    aria-label={`Assign someone to ${f.title}`}
                  >
                    <option value="">{addable.length ? "+ Assign a team member…" : "Everyone is assigned"}</option>
                    {addable.map((m) => (
                      <option key={m.id} value={m.id}>{m.name} · {m.title}{m.id === me.id ? " (you)" : ""}</option>
                    ))}
                  </select>
                )}
                {!isAdmin && (
                  <>
                    {f.youAreAssigned ? (
                      <Pill tone="good">You have access</Pill>
                    ) : f.yourPendingRequest ? (
                      <div className="flex items-center gap-2">
                        <Pill tone="warn">Request pending</Pill>
                        <button className="text-xs underline text-muted hover:text-ink" disabled={Boolean(busy)} onClick={() => act(f.id + "c", { action: "cancel", requestId: f.yourPendingRequest })}>Withdraw</button>
                      </div>
                    ) : f.status === "closed" ? (
                      <span className="text-xs text-muted">Closed fund</span>
                    ) : asking === f.id ? (
                      <div className="space-y-2">
                        <textarea className="input text-sm" rows={2} maxLength={300} placeholder="Why you'd like to join (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
                        <div className="flex gap-2">
                          <button className="btn btn-primary !py-1 text-xs" disabled={Boolean(busy)} onClick={() => act(f.id + "r", { action: "request", fundId: f.id, note })}>
                            {busy === f.id + "r" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Send request
                          </button>
                          <button className="btn btn-ghost !py-1 text-xs" onClick={() => setAsking(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button className="btn btn-ghost !py-1 text-xs" onClick={() => { setAsking(f.id); setNote(""); }}>
                        <UserPlus className="h-3.5 w-3.5" /> Ask to join this fund
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {data.requests.some((r) => r.status !== "pending") && (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-2">{isAdmin ? "Past requests" : "Your past requests"}</summary>
          <ul className="mt-2 space-y-1 text-xs text-ink-2">
            {data.requests.filter((r) => r.status !== "pending").map((r) => (
              <li key={r.id}>
                {r.member.name} → {r.fundTitle}: <b>{r.status}</b>
                {r.decidedBy && r.status !== "cancelled" && <> by {r.decidedBy}</>}
                {r.decidedAt && <> · {ago(r.decidedAt)}</>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function FundAdmin() {
  const { data, reload } = useJson<{ funds: FundCard[] }>("/api/funds");
  const { data: pp, reload: reloadPp } = useJson<{ accounts: PayPalAccount[] }>("/api/paypal/accounts");
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  async function setReturns(fundId: string, enabled: boolean) {
    setSaving(`ret:${fundId}`);
    try {
      setMsg((await api<{ message: string }>(`/api/funds/${fundId}/returns`, { json: { action: "setting", enabled } })).message);
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  async function setAccount(fundId: string, accountId: string) {
    setSaving(fundId);
    try {
      setMsg((await api<{ message: string }>("/api/paypal/accounts", { json: { action: "assign_fund", fundId, accountId } })).message);
      await Promise.all([reload(), reloadPp()]);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Funds and tracking codes</h2>
        <button className="btn btn-primary" onClick={() => setCreating((c) => !c)}><Plus className="h-4 w-4" /> New fund</button>
      </div>
      {creating && <CreateFund onCreated={() => { setCreating(false); void reload(); }} funds={data?.funds ?? []} />}
      {msg && <div className="card p-3 text-sm bg-brand-wash border-brand-line">{msg}</div>}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[1040px]">
          <thead>
            <tr className="text-left text-xs text-muted border-b border-line">
              <th className="px-4 py-2.5 font-medium">Fund</th>
              <th className="px-4 py-2.5 font-medium">Tracking codes</th>
              <th className="px-4 py-2.5 font-medium">PayPal account</th>
              <th className="px-4 py-2.5 font-medium" title="Donors may ask, when they give, for their share of whatever is left when the fund closes">Leftover back to donors</th>
              <th className="px-4 py-2.5 font-medium text-right">In</th>
              <th className="px-4 py-2.5 font-medium text-right">Out</th>
              <th className="px-4 py-2.5 font-medium text-right">Held</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {data?.funds.map((f) => (
              <tr key={f.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3"><Link className="font-medium hover:underline" href={`/funds/${f.slug}`}>{f.title}</Link><div className="text-xs text-muted">{f.donors} payers</div></td>
                <td className="px-4 py-3"><CodesEditor fundId={f.id} codes={f.trackingCodes} editable={f.status !== "closed"} onSaved={(m) => { setMsg(m); void reload(); }} /></td>
                <td className="px-4 py-3">
                  {f.status === "closed" || !pp ? (
                    <span className="text-xs text-ink-2">{pp?.accounts.find((a) => a.id === f.paypalAccountId)?.name ?? "—"}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <select
                        className="input !py-1 !w-auto max-w-[14rem] text-sm"
                        value={f.paypalAccountId}
                        disabled={saving === f.id}
                        onChange={(e) => void setAccount(f.id, e.target.value)}
                        aria-label={`PayPal account for ${f.title}'s donation link`}
                      >
                        {pp.accounts.filter((a) => a.status === "active" || a.id === f.paypalAccountId).map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                      {saving === f.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(f.donorReturns)}
                      disabled={f.status === "closed" || saving === `ret:${f.id}`}
                      onChange={(e) => void setReturns(f.id, e.target.checked)}
                      aria-label={`Let donors to ${f.title} ask for their share of the leftover back`}
                    />
                    <span className="text-ink-2">{f.donorReturns ? "Offered" : "Off"}</span>
                    {saving === `ret:${f.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />}
                  </label>
                  {f.returnOptIns ? <div className="text-xs text-muted">{f.returnOptIns} donor{f.returnOptIns === 1 ? "" : "s"} asked</div> : null}
                </td>
                <td className="px-4 py-3 text-right tnum">{usd(f.raised)}{f.bankIn ? <div className="text-xs text-muted">{usd(f.bankIn)} via bank</div> : null}</td>
                <td className="px-4 py-3 text-right tnum">{usd(f.spent)}</td>
                <td className="px-4 py-3 text-right tnum font-semibold">{usd(f.balance)}</td>
                <td className="px-4 py-3"><StatusPill status={f.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const CATS = Object.keys(CAT_LABEL);

/** A blank fund for filling in by hand. */
const blankDraft = (): Draft => ({ title: "", disaster: "", region: "", description: "", goal: 0, lat: 0, lng: 0, needs: [{ item: "", category: "food", unit: "", targetQty: 1, unitCost: 0 }], categoryCaps: {}, engine: "manual" });

function CreateFund({ onCreated, funds }: { onCreated: () => void; funds: FundCard[] }) {
  const [mode, setMode] = useState<"ai" | "manual">("ai");
  const [brief, setBrief] = useState("");
  const [d, setD] = useState<Draft | null>(null);
  const [donorReturns, setDonorReturns] = useState(false);
  // Payout policy is hidden in the tracker; new funds get these defaults.
  const policy = { dual: 2500, max: 6000, fast: 750 };
  const [codes, setCodes] = useState("");
  const [busy, setBusy] = useState<"draft" | "create" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function draft() {
    setBusy("draft");
    setErr(null);
    try {
      setD(await api<Draft>("/api/funds/draft", { json: { brief } }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function create() {
    if (!d) return;
    setBusy("create");
    setErr(null);
    try {
      await api("/api/funds", {
        json: {
          title: d.title,
          disaster: d.disaster,
          region: d.region,
          description: d.description,
          goalUsd: d.goal / 100,
          lat: d.lat,
          lng: d.lng,
          needs: d.needs.filter((n) => n.item.trim() && n.unit.trim()).map((n) => ({ ...n, unitCostUsd: n.unitCost / 100 })),
          categoryCaps: d.categoryCaps,
          dualApprovalUsd: policy.dual,
          maxSingleUsd: policy.max,
          fastLaneUsd: policy.fast,
          trackingCodes: codes.split(/[\s,]+/).map((c) => c.replace(/^#/, "").trim()).filter(Boolean),
          donorReturns,
        },
      });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const set = (patch: Partial<Draft>) => setD((x) => (x ? { ...x, ...patch } : x));
  const switchMode = (m: "ai" | "manual") => {
    if (m === mode) return;
    setMode(m);
    setErr(null);
    // By hand starts from a blank fund; AI waits for a description. An AI draft can still be edited in either.
    setD(m === "manual" ? (d && d.engine !== "manual" ? d : blankDraft()) : d && d.engine !== "manual" ? d : null);
  };
  const ready = d && d.title.trim() && d.description.trim() && d.goal > 0;

  return (
    <section className="card p-5 border-brand">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold flex items-center gap-2">{mode === "ai" ? <Wand2 className="h-4 w-4 text-brand" /> : <PenLine className="h-4 w-4 text-brand" />} {mode === "ai" ? "Set up a fund with AI" : "Set up a fund by hand"}</h3>
          <p className="text-xs text-ink-2 mt-1 max-w-2xl">
            {mode === "ai"
              ? "Describe the crisis in a few sentences. The local AI model drafts the fund, its needs and spending categories; you review and edit, then give it the tracking codes that bank and PayPal payments will carry."
              : "Fill in the fund yourself: its name, what it's for and its goal. Needs, spending caps and location are optional and can be left out. Then give it the tracking codes that bank and PayPal payments will carry."}
          </p>
        </div>
        <div className="flex rounded-lg border border-line p-1 text-xs font-semibold shrink-0" role="radiogroup" aria-label="How to set up the fund">
          <button type="button" role="radio" aria-checked={mode === "ai"} className={clsx("rounded-md px-3 py-1.5 inline-flex items-center gap-1.5", mode === "ai" ? "bg-brand text-white" : "text-ink-2")} onClick={() => switchMode("ai")}>
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Draft with AI
          </button>
          <button type="button" role="radio" aria-checked={mode === "manual"} className={clsx("rounded-md px-3 py-1.5 inline-flex items-center gap-1.5", mode === "manual" ? "bg-brand text-white" : "text-ink-2")} onClick={() => switchMode("manual")}>
            <PenLine className="h-3.5 w-3.5" aria-hidden /> Fill in by hand
          </button>
        </div>
      </div>
      {mode === "ai" && (
        <>
          <textarea className="input mt-3" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="e.g. Flash floods in Sylhet district, Bangladesh. ~4,000 families displaced into 30 school shelters, wells contaminated, roads cut. We partner with 5 local suppliers." />
          <button className="btn btn-primary mt-2" onClick={draft} disabled={!brief.trim() || Boolean(busy)}>
            {busy === "draft" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Draft fund
          </button>
        </>
      )}
      {d && (
        <div className="mt-5 grid gap-4">
          {d.engine !== "manual" && <Pill tone={d.engine === "local" ? "brand" : "neutral"} className="w-fit">{d.engine === "local" ? "Drafted by the local AI model: review every figure before publishing" : "Template draft (local AI unavailable)"}</Pill>}
          <div className="grid sm:grid-cols-2 gap-3">
            <div><label className="label" htmlFor="cf-title">Title</label><input id="cf-title" className="input" value={d.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Sylhet Flood Relief 2026" /></div>
            <div><label className="label" htmlFor="cf-region">Region</label><input id="cf-region" className="input" value={d.region} onChange={(e) => set({ region: e.target.value })} placeholder="e.g. Sylhet, Bangladesh" /></div>
            <div className="sm:col-span-2"><label className="label" htmlFor="cf-desc">Public description</label><textarea id="cf-desc" className="input" rows={3} value={d.description} onChange={(e) => set({ description: e.target.value })} placeholder="What happened, who the fund helps and what the money is for. Shown on the donation link." /></div>
            <div><label className="label" htmlFor="cf-goal">Goal (USD)</label><input id="cf-goal" className="input" type="number" min="1" value={d.goal ? d.goal / 100 : ""} onChange={(e) => set({ goal: Math.round(Number(e.target.value) * 100) })} placeholder="e.g. 50000" /></div>
            <div className="grid grid-cols-2 gap-2"><div><label className="label" htmlFor="cf-lat">Lat (optional)</label><input id="cf-lat" className="input" type="number" value={d.lat || ""} onChange={(e) => set({ lat: Number(e.target.value) })} /></div><div><label className="label" htmlFor="cf-lng">Lng (optional)</label><input id="cf-lng" className="input" type="number" value={d.lng || ""} onChange={(e) => set({ lng: Number(e.target.value) })} /></div></div>
          </div>
          <div>
            <label className="label">Needs (drive unit-price checks and the public progress bars)</label>
            <div className="space-y-2">
              {d.needs.map((n, i) => (
                <div key={i} className="grid grid-cols-[1fr_120px_90px_90px_90px_32px] gap-2 items-center text-sm">
                  <input className="input" value={n.item} onChange={(e) => set({ needs: d.needs.map((x, j) => (j === i ? { ...x, item: e.target.value } : x)) })} />
                  <select className="input" value={n.category} onChange={(e) => set({ needs: d.needs.map((x, j) => (j === i ? { ...x, category: e.target.value } : x)) })}>{CATS.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}</select>
                  <input className="input" value={n.unit} onChange={(e) => set({ needs: d.needs.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)) })} />
                  <input className="input" type="number" value={n.targetQty} onChange={(e) => set({ needs: d.needs.map((x, j) => (j === i ? { ...x, targetQty: Number(e.target.value) } : x)) })} />
                  <input className="input" type="number" step="0.01" value={n.unitCost / 100} onChange={(e) => set({ needs: d.needs.map((x, j) => (j === i ? { ...x, unitCost: Math.round(Number(e.target.value) * 100) } : x)) })} />
                  <button className="text-muted hover:text-critical" onClick={() => set({ needs: d.needs.filter((_, j) => j !== i) })} aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
              <div className="grid grid-cols-[1fr_120px_90px_90px_90px_32px] gap-2 text-xs text-muted"><span>Item</span><span>Category</span><span>Unit</span><span>Target</span><span>$/unit</span></div>
              <button type="button" className="btn btn-ghost !py-1 text-sm" onClick={() => set({ needs: [...d.needs, { item: "", category: "food", unit: "", targetQty: 1, unitCost: 0 }] })}><Plus className="h-4 w-4" /> Add a need</button>
              {mode === "manual" && <p className="text-xs text-muted">Optional. Rows without an item and a unit are left out.</p>}
            </div>
          </div>
          <div>
            <label className="label">Spending caps (% of funds raised)</label>
            <div className="flex flex-wrap gap-2">
              {CATS.map((c) => (
                <label key={c} className="flex items-center gap-1.5 text-xs border border-line rounded-lg px-2 py-1">
                  {CAT_LABEL[c]}
                  <input className="w-12 border-0 outline-none text-right tnum" type="number" value={d.categoryCaps[c] ?? ""} placeholder="—" onChange={(e) => set({ categoryCaps: { ...d.categoryCaps, [c]: Number(e.target.value) } })} />%
                </label>
              ))}
            </div>
          </div>
          <div className="max-w-md">
            <label className="label" htmlFor="cf-codes">Tracking codes (bank lines with these are tagged to this fund)</label>
            <input id="cf-codes" className="input font-mono" placeholder={`e.g. RO${funds.length + 1}, SYLHET`} value={codes} onChange={(e) => setCodes(e.target.value.toUpperCase())} />
            <p className="text-xs text-muted mt-1">Donors and staff write <span className="font-mono">#RO{funds.length + 1}</span> in the payment description; add <span className="font-mono">-MED</span>, <span className="font-mono">-FOOD</span>, <span className="font-mono">-LOG</span>… for a budget category.</p>
          </div>
          <label className="flex items-start gap-2.5 max-w-2xl">
            <input type="checkbox" className="mt-1" checked={donorReturns} onChange={(e) => setDonorReturns(e.target.checked)} />
            <span>
              <span className="text-sm font-medium">Let donors ask for their share of the leftover back</span>
              <span className="block text-xs text-ink-2">Donors can tick this when they give. If money is left when the fund closes, each one who asked gets the same share of it as their gift was of everything raised. You can change this later under Funds.</span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-primary w-fit" onClick={create} disabled={Boolean(busy) || !ready}>{busy === "create" && <Loader2 className="h-4 w-4 animate-spin" />} Publish fund</button>
            {!ready && <span className="text-xs text-muted">Add a title, a description and a goal to publish.</span>}
          </div>
        </div>
      )}
      {err && <p className="text-sm text-critical mt-2">{err}</p>}
    </section>
  );
}

// ------------------------------------------------------------------- Team ----

export function Team({ me, onSelfChange }: { me: Member; onSelfChange: () => Promise<void> }) {
  const { data, reload } = useJson<{ members: TeamMember[] }>("/api/ngo/members");
  const access = useAccess();
  const isAdmin = me.role === "admin";
  const [form, setForm] = useState({ name: "", title: "", username: "", password: "", role: "user" as Role });
  const [created, setCreated] = useState<{ name: string; username: string; password: string } | null>(null);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  useLive(undefined, (e) => {
    if (e.kind === "team") void reload();
  });

  const fundTitle = (id: string) => access.data?.funds.find((f) => f.id === id)?.title ?? id;

  async function post(key: string, body: Record<string, unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await api("/api/ngo/members", { json: body });
      setMsg({ text: ok });
      await reload();
      await access.reload();
      if (body.id === me.id) await onSelfChange();
      return true;
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    const ok = await post("create", { action: "create", ...form }, `Login created for ${form.name.trim()}`);
    if (ok) {
      setCreated({ name: form.name.trim(), username: form.username.trim().toLowerCase(), password: form.password });
      setForm({ name: "", title: "", username: "", password: "", role: "user" });
    }
  }

  const suggestPassword = () => {
    const words = ["river", "relief", "harbor", "monsoon", "lantern", "cedar", "delta", "beacon"];
    const pick = () => words[Math.floor(Math.random() * words.length)];
    return `${pick()}-${pick()}-${Math.floor(100 + Math.random() * 900)}`;
  };

  return (
    <div className={clsx("grid gap-6", isAdmin && "lg:grid-cols-[minmax(0,1fr)_340px]")}>
      <div className="space-y-3">
        {msg && <div className={clsx("card p-3 text-sm", msg.bad ? "border-bad-line text-critical" : "bg-brand-wash border-brand-line")}>{msg.text}</div>}
        <div className="card divide-y divide-line">
          {!data && <div className="h-32 animate-pulse" />}
          {data?.members.map((m) => (
            <div key={m.id} className={clsx("px-5 py-3.5", !m.active && "opacity-60")}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex-1 min-w-[12rem]">
                  <div className="font-medium flex flex-wrap items-center gap-1.5">
                    {m.name}
                    {m.id === me.id && <span className="text-xs text-muted">(you)</span>}
                    <Pill tone={m.role === "admin" ? "brand" : "neutral"}>{roleName(m.role)}{m.role === "donor" && " · read-only"}</Pill>
                    {!m.active && <Pill tone="bad">Deactivated</Pill>}
                  </div>
                  <div className="text-xs text-muted">
                    {m.title}
                    {m.username && <> · <span className="font-mono">{m.username}</span></>}
                  </div>
                  {m.role === "donor" ? (
                    <div className="text-xs text-ink-2 mt-1">
                      {m.viewFundIds?.length ? `Can see: ${m.viewFundIds.map(fundTitle).join(", ")}` : "Can't see any fund yet"} · read-only, no settings
                      {isAdmin && m.active && (access.data?.funds.length ?? 0) > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1" role="group" aria-label={`Funds ${m.name} can see`}>
                          {access.data!.funds.map((f) => {
                            const on = Boolean(m.viewFundIds?.includes(f.id));
                            return (
                              <label key={f.id} className="inline-flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={on}
                                  disabled={Boolean(busy)}
                                  onChange={() => {
                                    const next = on ? (m.viewFundIds ?? []).filter((x) => x !== f.id) : [...(m.viewFundIds ?? []), f.id];
                                    void post(m.id + "funds", { action: "donor_funds", id: m.id, fundIds: next }, `${m.name} can ${on ? "no longer" : "now"} see ${f.title}`);
                                  }}
                                />
                                {f.title}
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-ink-2 mt-1">{m.fundIds.length ? `Approver on: ${m.fundIds.map(fundTitle).join(", ")}` : "Not assigned to any fund"}</div>
                  )}
                </div>
                {isAdmin && m.id !== me.id && (
                  <div className="flex flex-wrap gap-1.5">
                    {m.active && (
                      <select
                        className="input !w-auto !py-1 text-xs"
                        value={m.role}
                        disabled={Boolean(busy)}
                        aria-label={`Role for ${m.name}`}
                        onChange={(e) => {
                          const r = e.target.value as Role;
                          if (r === "donor" && m.fundIds.length && !window.confirm(`${m.name} will be taken off ${m.fundIds.length} fund${m.fundIds.length === 1 ? "" : "s"} and can only view. Continue?`)) return;
                          void post(m.id + "role", { action: "update", id: m.id, role: r }, `${m.name} is now ${r === "admin" ? "an admin" : r === "donor" ? "a read-only donor" : "staff"}`);
                        }}
                      >
                        {(["user", "admin", "donor"] as const).map((r) => <option key={r} value={r}>{roleName(r)}</option>)}
                      </select>
                    )}
                    {m.active && <button className="btn btn-ghost !py-1 text-xs" disabled={Boolean(busy)} onClick={() => { setResetFor(resetFor === m.id ? null : m.id); setNewPassword(suggestPassword()); }}>Reset password</button>}
                    <button className={clsx("btn !py-1 text-xs", m.active ? "btn-danger" : "btn-ghost")} disabled={Boolean(busy)} onClick={() => post(m.id + "act", { action: "update", id: m.id, active: !m.active }, m.active ? `${m.name} was deactivated and removed from their funds` : `${m.name} was reactivated`)}>
                      {m.active ? "Deactivate" : "Reactivate"}
                    </button>
                  </div>
                )}
                {isAdmin && m.id === me.id && (
                  <button className="btn btn-ghost !py-1 text-xs" disabled={Boolean(busy)} onClick={() => { setResetFor(resetFor === m.id ? null : m.id); setNewPassword(""); }}>Change my password</button>
                )}
              </div>
              {resetFor === m.id && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input className="input !py-1.5 text-sm flex-1 min-w-[12rem] font-mono" value={newPassword} placeholder="New password (8+ characters)" onChange={(e) => setNewPassword(e.target.value)} aria-label={`New password for ${m.name}`} />
                  <button
                    className="btn btn-primary !py-1.5 text-xs"
                    disabled={Boolean(busy) || newPassword.length < 8}
                    onClick={async () => {
                      if (await post(m.id + "pw", { action: "update", id: m.id, password: newPassword }, m.id === me.id ? "Your password was changed" : `New password for ${m.name}: ${newPassword}. They've been signed out everywhere.`)) setResetFor(null);
                    }}
                  >
                    Save password
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        {!isAdmin && <p className="text-xs text-muted">Admins create logins and decide who is assigned to each fund. Ask one if you need access.</p>}
      </div>

      {isAdmin && (
        <Section title={<span className="flex items-center gap-2"><UserPlus className="h-4 w-4 text-brand" /> Create a login</span>}>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <input className="input" placeholder="Full name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Full name" />
            <input className="input" placeholder={form.role === "donor" ? "Label (e.g. Donor, Rotary Club of Puri)" : "Job title (e.g. Field Officer)"} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} aria-label="Job title" />
            <input className="input font-mono" placeholder="username" autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} aria-label="Username" />
            <div className="flex gap-2">
              <input className="input font-mono flex-1 min-w-0" placeholder="Password (8+ characters)" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} aria-label="Password" />
              <button type="button" className="btn btn-ghost !px-2.5 text-xs shrink-0" onClick={() => setForm({ ...form, password: suggestPassword() })}>Suggest</button>
            </div>
            <div className="flex rounded-lg border border-line p-1 text-xs font-semibold">
              {(["user", "admin", "donor"] as const).map((r) => (
                <button type="button" key={r} className={clsx("flex-1 rounded-md py-1.5", form.role === r ? "bg-brand text-white" : "text-ink-2")} onClick={() => setForm({ ...form, role: r })}>
                  {roleName(r)}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted">
              {form.role === "admin"
                ? "Admins manage the team, fund assignments, funds and vendors."
                : form.role === "donor"
                  ? "Donors get read-only access to the funds you tick for them after creating the login: money flow, transactions, funds and Copilot answers, with private details redacted. No settings, sources or audit log."
                  : "Staff start with no funds. Assign them under Funds & access, or they can ask to join a fund."}
            </p>
            <button className="btn btn-primary w-full" disabled={Boolean(busy) || !form.name.trim() || !form.username.trim() || form.password.length < 8}>
              {busy === "create" && <Loader2 className="h-4 w-4 animate-spin" />} Create login
            </button>
          </form>
          {created && (
            <div className="mt-4 rounded-lg bg-brand-wash p-3 text-sm">
              <div className="font-semibold">Share these with {created.name}</div>
              <div className="font-mono text-xs mt-1">username: {created.username}<br />password: {created.password}</div>
              <p className="text-xs text-ink-2 mt-1">This is the only time the password is shown.</p>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Vendors ----

export function Vendors() {
  const { data, reload } = useJson<{ vendors: { id: string; name: string; category: string; location: string; verified: boolean; funds: string[] }[] }>("/api/vendors");
  const [form, setForm] = useState({ name: "", paypalEmail: "", category: "food", location: "" });
  const [err, setErr] = useState<string | null>(null);
  async function verify(id: string) {
    await api("/api/vendors", { json: { verifyId: id } });
    await reload();
  }
  async function add() {
    setErr(null);
    try {
      await api("/api/vendors", { json: form });
      setForm({ name: "", paypalEmail: "", category: "food", location: "" });
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-6">
      <div className="card divide-y divide-line">
        {data?.vendors.map((v) => (
          <div key={v.id} className="flex items-center gap-3 px-5 py-3">
            <div className="flex-1 min-w-0">
              <div className="font-medium flex items-center gap-1.5">{v.name} {v.verified && <BadgeCheck className="h-4 w-4 text-brand" />}</div>
              <div className="text-xs text-muted">{CAT_LABEL[v.category]} · {v.location} · {v.funds.length} funds</div>
            </div>
            {v.verified ? <Pill tone="good">Verified</Pill> : <button className="btn btn-ghost !py-1 text-xs" onClick={() => verify(v.id)}>Mark verified</button>}
          </div>
        ))}
      </div>
      <Section title="Register a payee">
        <div className="space-y-2">
          <input className="input" placeholder="Business name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" placeholder="PayPal or contact email" value={form.paypalEmail} onChange={(e) => setForm({ ...form, paypalEmail: e.target.value })} />
          <select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{CATS.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}</select>
          <input className="input" placeholder="City, region" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          <button className="btn btn-primary w-full" onClick={add}>Add payee</button>
          {err && <p className="text-xs text-critical">{err}</p>}
          <p className="text-xs text-muted">Registered payees show by name in the money flow. Mark one verified once you&apos;ve checked its registration.</p>
        </div>
      </Section>
    </div>
  );
}
