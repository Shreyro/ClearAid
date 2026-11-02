"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BadgeCheck, Building2, Loader2, Plus, Sparkles, Trash2, Wand2 } from "lucide-react";
import clsx from "clsx";
import { api, ago, useJson, useLive, usd } from "@/components/hooks";
import { Empty, Pill, RiskBadge, Section, StatusIcon, StatusPill } from "@/components/ui";
import { Chat } from "@/components/Chat";
import { CAT_LABEL, type WView } from "@/components/SpendCard";

type Sess = { session: { role: string; id?: string; name?: string }; personas: { ngo: { id: string; name: string; sub: string }[] } };
type Tab = "queue" | "funds" | "vendors" | "copilot";

export default function NgoConsole() {
  const { data: sess, reload } = useJson<Sess>("/api/session");
  const [tab, setTab] = useState<Tab>("queue");
  useEffect(() => {
    const h = () => void reload();
    window.addEventListener("clearaid:persona", h);
    return () => window.removeEventListener("clearaid:persona", h);
  }, [reload]);

  if (!sess) return <div className="mx-auto max-w-6xl px-4 py-10"><div className="card h-40 animate-pulse" /></div>;
  if (sess.session.role !== "ngo") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <Building2 className="h-10 w-10 text-brand mx-auto" />
        <h1 className="text-2xl font-semibold mt-3">NGO console</h1>
        <p className="text-ink-2 mt-2">Review AI-audited withdrawal requests, release PayPal payouts, run funds and talk to the Copilot. Choose an admin:</p>
        <div className="grid sm:grid-cols-2 gap-2 mt-6 text-left">
          {sess.personas.ngo.map((d) => (
            <button
              key={d.id}
              className="card p-4 hover:border-brand"
              onClick={async () => {
                await api("/api/session", { json: { role: "ngo", id: d.id } });
                window.dispatchEvent(new Event("clearaid:persona"));
                await reload();
              }}
            >
              <div className="font-semibold">{d.name}</div>
              <div className="text-xs text-muted">{d.sub}</div>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted mt-4">Tip: large withdrawals need both admins, so switch between them to see dual approval in action.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-sm text-muted">Coastal Relief Collective · signed in as {sess.session.name}</div>
          <h1 className="text-3xl font-semibold tracking-tight">NGO console</h1>
        </div>
        <div className="flex rounded-xl border border-line bg-surface p-1 text-sm font-semibold">
          {(
            [
              ["queue", "Review queue"],
              ["funds", "Funds"],
              ["vendors", "Vendors"],
              ["copilot", "Copilot"],
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={clsx("px-3 py-1.5 rounded-lg", tab === k ? "bg-brand text-white" : "text-ink-2")}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-6">
        {tab === "queue" && <Queue me={sess.session.id!} />}
        {tab === "funds" && <Funds />}
        {tab === "vendors" && <Vendors />}
        {tab === "copilot" && (
          <div className="grid lg:grid-cols-[minmax(0,1fr)_300px] gap-6">
            <Chat
              endpoint="/api/copilot"
              title="ClearAid Copilot"
              subtitle="Claude with ClearAid tools plus the PayPal Agent Toolkit (transactions, refunds, disputes, invoices). Money-moving actions wait for your approval."
              placeholder="Ask about funds, approvals, refunds or reconciliation…"
              height={460}
              suggestions={[
                "Reconcile the last 31 days of donations against PayPal",
                "Which pending requests are safe to approve? Approve the clean ones.",
                "Refund $20 of the most recent Cyclone Asha donation; the donor asked for it back",
                "Draft an invoice to Brightline Software for their $5,000 employee-match pledge",
              ]}
            />
            <div className="card p-5 text-sm self-start">
              <h3 className="font-semibold">Guardrails</h3>
              <ul className="mt-2 space-y-2 text-ink-2 text-xs">
                <li>Refunds, sending invoices and approvals pause for your explicit confirmation.</li>
                <li>Refunds are capped at the donor&apos;s unspent share, so the AI cannot overdraw a fund.</li>
                <li>Every refund the Copilot makes is written to the public hash-chained ledger.</li>
                <li>The Copilot cannot approve its own fast-lane decisions or bypass dual approval.</li>
                <li>PayPal tools come from the official <code>@paypal/agent-toolkit</code>, adapted to Claude tool use.</li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Queue ----

function Queue({ me }: { me: string }) {
  const { data, reload } = useJson<{ withdrawals: (WView & { approvals: (WView["approvals"][number] & { by?: string })[] })[] }>("/api/withdrawals?status=auditing,pending_approval,payout_failed");
  const recent = useJson<{ withdrawals: WView[] }>("/api/withdrawals?status=paid,rejected");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  useLive(undefined, (e) => {
    if (e.kind === "withdrawal" || e.kind === "ledger") {
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
        {data && !items.length && <div className="card"><Empty>Nothing waiting. New vendor requests appear here live.</Empty></div>}
        {items.map((w) => {
          const fails = w.audit?.checks.filter((c) => c.status === "fail") ?? [];
          const warns = w.audit?.checks.filter((c) => c.status === "warn") ?? [];
          const mine = w.approvals.some((a) => a.by === me);
          const signed = w.approvals.filter((a) => a.decision === "approve").length;
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
                <div className="mt-3 rounded-lg bg-[#f7f7f3] p-3 text-sm">
                  <div className="flex items-start gap-2"><Sparkles className="h-4 w-4 text-brand mt-0.5 shrink-0" /><span>{w.audit.summary}</span></div>
                  {[...fails, ...warns].slice(0, 4).map((c) => (
                    <div key={c.id} className="flex items-start gap-2 mt-1.5 text-xs"><StatusIcon status={c.status} className="h-3.5 w-3.5 mt-0.5" /><span><b>{c.label}:</b> {c.detail}</span></div>
                  ))}
                  {!fails.length && !warns.length && <div className="text-xs text-good-ink mt-1.5">All {w.audit.checks.length} checks passed</div>}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2 mt-4">
                <span className="text-xs text-ink-2 mr-auto">
                  Signatures {signed}/{w.requiredApprovals}
                  {w.approvals.map((a) => ` · ${a.name}`).join("")}
                </span>
                <Link href={`/spend/${w.id}`} className="btn btn-ghost !py-1.5 text-xs">Full audit</Link>
                <button className="btn btn-danger !py-1.5 text-xs" disabled={Boolean(busy) || w.status === "auditing" || mine} onClick={() => decide(w.id, "reject")}>Reject</button>
                <button className="btn btn-primary !py-1.5 text-xs" disabled={Boolean(busy) || w.status === "auditing" || mine} title={mine ? "You already signed; a different admin must co-sign" : undefined} onClick={() => decide(w.id, "approve")}>
                  {busy === w.id + "approve" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {mine ? "Waiting for co-signer" : signed + 1 >= w.requiredApprovals ? "Approve & pay via PayPal" : "Approve (1st signature)"}
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

type FundCard = { id: string; slug: string; title: string; status: string; raised: number; spent: number; balance: number; donors: number; transparency: number };
type Draft = { title: string; disaster: string; region: string; description: string; goal: number; lat: number; lng: number; needs: { item: string; category: string; unit: string; targetQty: number; unitCost: number }[]; categoryCaps: Record<string, number>; engine: string };

function Funds() {
  const { data, reload } = useJson<{ funds: FundCard[] }>("/api/funds");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function close(id: string, action: "start" | "finalize") {
    if (action === "finalize" && !confirm("Finalise closure? Refunds will be sent through PayPal and carry-forwards recorded. This cannot be undone.")) return;
    setBusy(id + action);
    setMsg(null);
    try {
      const r = await api<{ refunded?: number; refunds?: number; carried?: number; carries?: number; errors?: string[] }>(`/api/funds/${id}/close`, { json: { action } });
      setMsg(action === "finalize" ? `Closed: ${usd(r.refunded ?? 0)} refunded to ${r.refunds} donors through PayPal, ${usd(r.carried ?? 0)} carried forward for ${r.carries} donors.${r.errors?.length ? ` ${r.errors.length} refund errors.` : ""}` : "Closing started. Donors can now choose refund or carry forward.");
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Your relief funds</h2>
        <button className="btn btn-primary" onClick={() => setCreating((c) => !c)}><Plus className="h-4 w-4" /> New fund</button>
      </div>
      {creating && <CreateFund onCreated={() => { setCreating(false); void reload(); }} funds={data?.funds ?? []} />}
      {msg && <div className="card p-3 text-sm bg-brand-wash border-[#bfe3dc]">{msg}</div>}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="text-left text-xs text-muted border-b border-line">
              <th className="px-4 py-2.5 font-medium">Fund</th>
              <th className="px-4 py-2.5 font-medium text-right">Raised</th>
              <th className="px-4 py-2.5 font-medium text-right">Paid out</th>
              <th className="px-4 py-2.5 font-medium text-right">Balance</th>
              <th className="px-4 py-2.5 font-medium text-right">Score</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {data?.funds.map((f) => (
              <tr key={f.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3"><Link className="font-medium hover:underline" href={`/funds/${f.slug}`}>{f.title}</Link><div className="text-xs text-muted">{f.donors} donors</div></td>
                <td className="px-4 py-3 text-right tnum">{usd(f.raised)}</td>
                <td className="px-4 py-3 text-right tnum">{usd(f.spent)}</td>
                <td className="px-4 py-3 text-right tnum font-semibold">{usd(f.balance)}</td>
                <td className="px-4 py-3 text-right tnum">{f.transparency}</td>
                <td className="px-4 py-3"><StatusPill status={f.status} /></td>
                <td className="px-4 py-3 text-right">
                  {f.status === "active" && <button className="btn btn-ghost !py-1 text-xs" disabled={Boolean(busy)} onClick={() => close(f.id, "start")}>Start closing</button>}
                  {f.status === "closing" && (
                    <button className="btn btn-primary !py-1 text-xs" disabled={Boolean(busy)} onClick={() => close(f.id, "finalize")}>
                      {busy === f.id + "finalize" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Finalise: refund &amp; carry forward
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const CATS = Object.keys(CAT_LABEL);

function CreateFund({ onCreated, funds }: { onCreated: () => void; funds: FundCard[] }) {
  const [brief, setBrief] = useState("");
  const [d, setD] = useState<Draft | null>(null);
  const [policy, setPolicy] = useState({ dual: 2500, max: 6000, fast: 750, leftover: "carry_forward", carry: "" });
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
          needs: d.needs.map((n) => ({ ...n, unitCostUsd: n.unitCost / 100 })),
          categoryCaps: d.categoryCaps,
          dualApprovalUsd: policy.dual,
          maxSingleUsd: policy.max,
          fastLaneUsd: policy.fast,
          leftoverDefault: policy.leftover,
          carryForwardFundId: policy.carry || undefined,
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

  return (
    <section className="card p-5 border-brand">
      <h3 className="font-semibold flex items-center gap-2"><Wand2 className="h-4 w-4 text-brand" /> Set up a fund with AI</h3>
      <p className="text-xs text-ink-2 mt-1">Describe the crisis in a few sentences. Claude drafts the needs list, unit costs and spending caps; you review and edit before anything goes live.</p>
      <textarea className="input mt-3" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="e.g. Flash floods in Sylhet district, Bangladesh. ~4,000 families displaced into 30 school shelters, wells contaminated, roads cut. We partner with 5 local suppliers." />
      <button className="btn btn-primary mt-2" onClick={draft} disabled={!brief.trim() || Boolean(busy)}>
        {busy === "draft" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Draft fund
      </button>
      {d && (
        <div className="mt-5 grid gap-4">
          <Pill tone={d.engine === "claude" ? "brand" : "neutral"} className="w-fit">{d.engine === "claude" ? "Drafted by Claude: review before publishing" : "Template draft (no AI key)"}</Pill>
          <div className="grid sm:grid-cols-2 gap-3">
            <div><label className="label">Title</label><input className="input" value={d.title} onChange={(e) => set({ title: e.target.value })} /></div>
            <div><label className="label">Region</label><input className="input" value={d.region} onChange={(e) => set({ region: e.target.value })} /></div>
            <div className="sm:col-span-2"><label className="label">Public description</label><textarea className="input" rows={3} value={d.description} onChange={(e) => set({ description: e.target.value })} /></div>
            <div><label className="label">Goal (USD)</label><input className="input" type="number" value={d.goal / 100} onChange={(e) => set({ goal: Math.round(Number(e.target.value) * 100) })} /></div>
            <div className="grid grid-cols-2 gap-2"><div><label className="label">Lat</label><input className="input" type="number" value={d.lat} onChange={(e) => set({ lat: Number(e.target.value) })} /></div><div><label className="label">Lng</label><input className="input" type="number" value={d.lng} onChange={(e) => set({ lng: Number(e.target.value) })} /></div></div>
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
              <div className="grid grid-cols-[1fr_120px_90px_90px_90px_32px] gap-2 text-[11px] text-muted"><span>Item</span><span>Category</span><span>Unit</span><span>Target</span><span>$/unit</span></div>
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
          <div className="grid sm:grid-cols-5 gap-3">
            <div><label className="label">Dual approval at ($)</label><input className="input" type="number" value={policy.dual} onChange={(e) => setPolicy({ ...policy, dual: Number(e.target.value) })} /></div>
            <div><label className="label">Max withdrawal ($)</label><input className="input" type="number" value={policy.max} onChange={(e) => setPolicy({ ...policy, max: Number(e.target.value) })} /></div>
            <div><label className="label">AI fast lane up to ($)</label><input className="input" type="number" value={policy.fast} onChange={(e) => setPolicy({ ...policy, fast: Number(e.target.value) })} /></div>
            <div><label className="label">Leftover default</label><select className="input" value={policy.leftover} onChange={(e) => setPolicy({ ...policy, leftover: e.target.value })}><option value="carry_forward">Carry forward</option><option value="refund">Refund</option></select></div>
            <div><label className="label">Carry forward to</label><select className="input" value={policy.carry} onChange={(e) => setPolicy({ ...policy, carry: e.target.value })}><option value="">—</option>{funds.filter((f) => f.status === "active").map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}</select></div>
          </div>
          <button className="btn btn-primary w-fit" onClick={create} disabled={Boolean(busy)}>{busy === "create" && <Loader2 className="h-4 w-4 animate-spin" />} Publish fund</button>
        </div>
      )}
      {err && <p className="text-sm text-critical mt-2">{err}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- Vendors ----

function Vendors() {
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
      <Section title="Register a vendor">
        <div className="space-y-2">
          <input className="input" placeholder="Business name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" placeholder="PayPal email (receives Payouts)" value={form.paypalEmail} onChange={(e) => setForm({ ...form, paypalEmail: e.target.value })} />
          <select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{CATS.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}</select>
          <input className="input" placeholder="City, region" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          <button className="btn btn-primary w-full" onClick={add}>Add vendor (unverified)</button>
          {err && <p className="text-xs text-critical">{err}</p>}
          <p className="text-xs text-muted">Unverified vendors can submit requests, but the audit fails the &quot;Vendor verified&quot; check until you complete KYB and mark them verified.</p>
        </div>
      </Section>
    </div>
  );
}
