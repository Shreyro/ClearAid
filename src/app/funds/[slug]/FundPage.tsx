"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { BadgeCheck, CalendarDays, Link2, MapPin, RotateCcw } from "lucide-react";
import { ago, useJson, useLive, usd } from "@/components/hooks";
import { Meter, Pill, Section, Stat, StatusPill } from "@/components/ui";
import { DonateBox } from "@/components/DonateBox";
import { CategoryBars, MoneyFlowChart } from "@/components/Charts";
import { InsightsCard } from "@/components/InsightsCard";
import { LedgerGrid, type LedgerEntry } from "@/components/LedgerGrid";
import { Chat } from "@/components/Chat";
import { CAT_LABEL, SpendCard, type WView } from "@/components/SpendCard";

type Detail = {
  fund: {
    id: string;
    slug: string;
    title: string;
    disaster: string;
    region: string;
    description: string;
    goal: number;
    status: string;
    startedAt: string;
    closingStartedAt?: string;
    accent: string;
    policy: { categoryCaps: Record<string, number>; dualApprovalThreshold: number; maxSingleWithdrawal: number; fastLaneMax: number; leftoverDefault: string };
    needs: { id: string; item: string; unit: string; targetQty: number; fulfilledQty: number; unitCost: number; category: string }[];
    demo?: boolean;
  };
  ngo: { name: string; verified: boolean; registration: string; description: string };
  stats: {
    raised: number;
    spent: number;
    refunded: number;
    carriedOut: number;
    balance: number;
    donors: number;
    byCategory: Record<string, number>;
    pending: number;
    flagged: number;
    paidCount: number;
    transparency: number;
    transparencyBreakdown: Record<string, number>;
    chainValid: boolean;
    beneficiaries: number;
    runwayDays: number | null;
  };
  withdrawals: WView[];
  donations: { id: string; amount: number; at: string; by: string; source: string }[];
  closure: { donors: number; leftover: number; electedRefund: number; electedCarry: number; undecided: number; defaultChoice: string } | null;
  otherFunds: { id: string; title: string; slug: string }[];
};

const BREAKDOWN: Record<string, [string, number]> = {
  verified: ["Spend with a clean AI audit", 35],
  proof: ["Spend with delivery photos", 20],
  overhead: ["Admin overhead within cap", 15],
  integrity: ["Ledger hash chain intact", 15],
  responsiveness: ["No requests stuck > 48h", 15],
};

export function FundPage({ slug }: { slug: string }) {
  const { data, error, reload } = useJson<Detail>(`/api/funds/${slug}`);
  const { data: ledger, reload: reloadLedger } = useJson<{ entries: LedgerEntry[] }>(`/api/funds/${slug}/ledger`);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [tab, setTab] = useState<"spending" | "ledger">("spending");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void reload();
      void reloadLedger();
    }, 250);
  }, [reload, reloadLedger]);

  const live = useLive(data?.fund.id ?? null, (ev) => {
    if (ev.entry) setFresh((s) => new Set(s).add(ev.entry!.seq));
    refresh();
  });
  useEffect(() => {
    const h = () => refresh();
    window.addEventListener("clearaid:persona", h);
    return () => window.removeEventListener("clearaid:persona", h);
  }, [refresh]);

  if (error) return <div className="mx-auto max-w-6xl px-4 py-16 text-center text-ink-2">{error}</div>;
  if (!data) return <div className="mx-auto max-w-6xl px-4 py-10"><div className="card h-48 animate-pulse" /></div>;

  const { fund, stats, ngo } = data;
  const catRows = Object.entries(stats.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: CAT_LABEL[k] ?? k, value: v, capPct: fund.policy.categoryCaps[k], raised: stats.raised }));
  const recent = (ledger?.entries ?? []).slice(-8).reverse();

  return (
    <div>
      <div className="border-b border-line bg-surface">
        <div className="h-1" style={{ background: fund.accent }} />
        <div className="mx-auto max-w-6xl px-4 py-8">
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
            <span className="font-medium text-ink">{ngo.name}</span>
            {ngo.verified && (
              <Pill tone="brand">
                <BadgeCheck className="h-3.5 w-3.5" /> Verified NGO
              </Pill>
            )}
            <StatusPill status={fund.status} />
            {fund.demo && <Pill>Demo scenario · fictional</Pill>}
          </div>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight mt-3 max-w-3xl">{fund.title}</h1>
          <div className="flex flex-wrap gap-4 mt-3 text-sm text-ink-2">
            <span className="inline-flex items-center gap-1"><MapPin className="h-4 w-4" /> {fund.region}</span>
            <span className="inline-flex items-center gap-1"><CalendarDays className="h-4 w-4" /> Opened {ago(fund.startedAt)}</span>
            <span className="inline-flex items-center gap-1"><Link2 className="h-4 w-4" /> {stats.chainValid ? "Ledger verified" : "Ledger integrity error"}</span>
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${live ? "bg-good live-dot" : "bg-line-strong"}`} /> {live ? "Live" : "Connecting…"}
            </span>
          </div>
          <p className="mt-4 text-ink-2 max-w-3xl">{fund.description}</p>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 py-6 grid lg:grid-cols-[minmax(0,1fr)_340px] gap-6">
        <div className="space-y-6 min-w-0">
          {fund.status === "closing" && data.closure && <ClosureBanner closure={data.closure} />}

          <section className="card p-5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <div className="text-3xl font-semibold tracking-tight tnum">{usd(stats.raised)}</div>
                <div className="text-sm text-ink-2">raised of {usd(fund.goal)} goal from {stats.donors.toLocaleString()} donors</div>
              </div>
              <div className="text-sm text-ink-2">{Math.round((stats.raised / fund.goal) * 100)}% funded</div>
            </div>
            <div className="mt-3">
              <Meter value={stats.raised} max={fund.goal} color={fund.accent} />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5">
              <Stat label="Paid to vendors" value={usd(stats.spent, true)} sub={`${stats.paidCount} audited payouts`} />
              <Stat label="Balance in fund" value={usd(stats.balance, true)} sub={stats.runwayDays != null ? `~${stats.runwayDays} days at current pace` : "No recent spending"} />
              <Stat label="People reached" value={stats.beneficiaries.toLocaleString()} sub="vendor delivery logs" />
              <Stat label="Stopped by audit" value={String(stats.flagged)} sub={`${stats.pending} in review now`} />
            </div>
            {(stats.refunded > 0 || stats.carriedOut > 0) && (
              <p className="text-xs text-ink-2 mt-4 flex items-center gap-1.5">
                <RotateCcw className="h-3.5 w-3.5" /> {usd(stats.refunded)} refunded to donors · {usd(stats.carriedOut)} carried forward to other funds
              </p>
            )}
          </section>

          <InsightsCard fundId={fund.id} />

          <div className="grid md:grid-cols-2 gap-6">
            <Section title="Money in vs money out">
              {ledger ? <MoneyFlowChart entries={ledger.entries} startedAt={fund.startedAt} /> : <div className="h-56" />}
            </Section>
            <Section title="Where the money went">
              <CategoryBars rows={catRows} />
            </Section>
          </div>

          <Section title="Needs on the ground" action={<span className="text-xs text-muted">Updated automatically when a payout is released</span>}>
            <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-4">
              {fund.needs.map((n) => (
                <li key={n.id}>
                  <div className="flex justify-between gap-2 text-sm">
                    <span className="truncate">{n.item}</span>
                    <span className="text-ink-2 tnum shrink-0">{Math.round((n.fulfilledQty / n.targetQty) * 100)}%</span>
                  </div>
                  <div className="mt-1.5"><Meter value={n.fulfilledQty} max={n.targetQty} /></div>
                  <div className="text-xs text-muted mt-1 tnum">{n.fulfilledQty.toLocaleString()} of {n.targetQty.toLocaleString()} {n.unit} · ~{usd(n.unitCost)} each</div>
                </li>
              ))}
            </ul>
          </Section>

          <section className="card p-5">
            <div className="flex items-center gap-1 mb-4 border-b border-line -mx-5 px-5">
              {(["spending", "ledger"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} className={`px-3 pb-2.5 text-sm font-semibold border-b-2 -mb-px ${tab === t ? "border-brand text-ink" : "border-transparent text-muted"}`}>
                  {t === "spending" ? `Every withdrawal (${data.withdrawals.length})` : `Public ledger (${ledger?.entries.length ?? "…"})`}
                </button>
              ))}
            </div>
            {tab === "spending" ? (
              <div className="grid gap-3">
                {data.withdrawals.map((w) => (
                  <SpendCard key={w.id} w={w} />
                ))}
              </div>
            ) : ledger ? (
              <LedgerGrid entries={ledger.entries} fundId={fund.id} />
            ) : null}
          </section>

          <Chat
            endpoint={`/api/funds/${fund.id}/ask`}
            title="Ask ClearAid"
            subtitle="Questions are answered by Claude using only this fund's public, redacted records."
            placeholder="e.g. How much went to shelter, and who supplied it?"
            suggestions={["How much has been spent on shelter, and who supplied it?", "Were any withdrawal requests rejected? Why?", "What did my donation pay for?", "Which vendor has been paid the most?"]}
          />
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 self-start">
          <DonateBox fund={fund} onDonated={refresh} />

          <section className="card p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Transparency score</h2>
              <span className="text-2xl font-semibold tnum">{stats.transparency}<span className="text-sm text-muted">/100</span></span>
            </div>
            <ul className="mt-3 space-y-2 text-xs">
              {Object.entries(stats.transparencyBreakdown).map(([k, v]) => (
                <li key={k}>
                  <div className="flex justify-between text-ink-2"><span>{BREAKDOWN[k]?.[0] ?? k}</span><span className="tnum">{v}/{BREAKDOWN[k]?.[1]}</span></div>
                  <div className="mt-1"><Meter value={v} max={BREAKDOWN[k]?.[1] ?? 1} /></div>
                </li>
              ))}
            </ul>
          </section>

          <section className="card p-5">
            <h2 className="font-semibold flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${live ? "bg-good live-dot" : "bg-line-strong"}`} /> Live activity
            </h2>
            <ul className="mt-3 space-y-2.5">
              {recent.map((e) => (
                <li key={e.seq} className={`text-xs rounded-lg -mx-2 px-2 py-1 ${fresh.has(e.seq) ? "flash" : ""}`}>
                  <div className="flex justify-between gap-2">
                    <span className="font-medium truncate">{e.actor}</span>
                    <span className={`tnum font-semibold ${e.amount < 0 ? "text-[#9b3d17]" : e.amount > 0 ? "text-good-ink" : "text-muted"}`}>
                      {e.amount === 0 ? "notice" : `${e.amount > 0 ? "+" : "−"}${usd(Math.abs(e.amount))}`}
                    </span>
                  </div>
                  <div className="text-muted truncate">{e.memo}</div>
                  <div className="text-muted">{ago(e.ts)} · #{e.seq}</div>
                </li>
              ))}
            </ul>
          </section>

          <section className="card p-5 text-sm">
            <h2 className="font-semibold">Fund rules (enforced in code)</h2>
            <ul className="mt-2 space-y-1.5 text-ink-2 text-xs">
              <li>Two NGO signatures for withdrawals of {usd(fund.policy.dualApprovalThreshold)} or more</li>
              <li>No single withdrawal over {usd(fund.policy.maxSingleWithdrawal)}</li>
              <li>Receipt and delivery photos required; vendors must be verified</li>
              {fund.policy.fastLaneMax > 0 && <li>AI fast lane: clean requests up to {usd(fund.policy.fastLaneMax)} are paid without waiting</li>}
              <li>Admin overhead capped at {fund.policy.categoryCaps.admin ?? 10}% of funds raised</li>
              <li>Leftovers: {fund.policy.leftoverDefault === "refund" ? "refunded" : "carried forward"} unless the donor chooses otherwise</li>
            </ul>
            <p className="text-xs text-muted mt-3">{ngo.registration}</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function ClosureBanner({ closure }: { closure: NonNullable<Detail["closure"]> }) {
  const pct = (v: number) => `${Math.round((v / Math.max(closure.leftover, 1)) * 100)}%`;
  return (
    <section className="card p-5 border-[#f3d48a] bg-[#fffaf0]">
      <h2 className="font-semibold">The response is over: {usd(closure.leftover)} is unspent</h2>
      <p className="text-sm text-ink-2 mt-1">
        Each of the {closure.donors} donors with an unspent share chooses: a refund to their PayPal account, or carry it forward to another fund. Undecided shares are {closure.defaultChoice === "refund" ? "refunded" : "carried forward"} when the NGO finalises.
      </p>
      <div className="flex h-3 rounded-full overflow-hidden mt-4 gap-0.5 bg-surface">
        <div style={{ width: pct(closure.electedRefund), background: "var(--series-1)" }} title="Chose refund" />
        <div style={{ width: pct(closure.electedCarry), background: "var(--series-2)" }} title="Chose carry forward" />
        <div style={{ width: pct(closure.undecided), background: "#d9d7cf" }} title="Undecided" />
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-ink-2 mt-2">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--series-1)" }} /> Refund {usd(closure.electedRefund)}</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--series-2)" }} /> Carry forward {usd(closure.electedCarry)}</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#d9d7cf]" /> Undecided {usd(closure.undecided)}</span>
      </div>
      <Link href="/me" className="btn btn-primary mt-4">I donated: choose for my share</Link>
    </section>
  );
}
