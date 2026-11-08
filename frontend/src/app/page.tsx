"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import clsx from "clsx";
import { Page, useMe } from "@/components/AppShell";
import { useJson, useLive, usd } from "@/components/hooks";
import { Empty, Section, Stat, StatusPill } from "@/components/ui";
import { MoneyFlowChart } from "@/components/Charts";
import { Sankey, type FlowGraph } from "@/components/Sankey";
import { CodeChip } from "@/components/banking";
import { MovementList, PartyTable, type Movement, type Party } from "@/components/FlowParts";

type Overview = {
  totals: { received: number; spent: number; returned: number; balance: number; untagged: { count: number; in: number; out: number } };
  integrity: { ledgers: number; brokenLedgers: string[]; auditValid: boolean; auditEntries: number };
  funds: { id: string; slug: string; title: string; status: string; accent: string; codes: string[]; received: number; spent: number; returned: number; balance: number; chainValid: boolean }[];
  flow: { category: FlowGraph; payee: FlowGraph };
  sources: Party[];
  payees: Party[];
  recent: Movement[];
  timeline: { ts: string; type: string; amount: number }[];
  timelineStart: string;
};

export default function MoneyFlowPage() {
  const { me } = useMe();
  const router = useRouter();
  const { data, reload } = useJson<Overview>("/api/overview");
  const [view, setView] = useState<"category" | "payee">("category");
  useLive(undefined, (e) => {
    if (e.kind === "ledger" || e.kind === "bank") void reload();
  });

  if (!data) return <Page title="Money flow"><div className="grid gap-4 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="card h-24 animate-pulse" />)}</div></Page>;

  if (!data.funds.length)
    return (
      <Page title={`Welcome, ${me.name.split(" ")[0]}`}>
        <div className="card"><Empty>You don&apos;t have access to any funds yet, so there&apos;s nothing to trace. <Link href="/settings?tab=access" className="underline">Ask to join a fund</Link> and an admin will approve it.</Empty></div>
      </Page>
    );

  const t = data.totals;
  const u = t.untagged;
  const intact = data.integrity.auditValid && data.integrity.brokenLedgers.length === 0;
  return (
    <Page
      wide
      title="Money flow"
      subtitle={`Where money came from, which fund it went to, and where it went next${me.role === "admin" ? " across all of your NGO's funds" : " for the funds you have access to"}.`}
    >
      <div className={clsx("grid grid-cols-2 gap-4", t.returned > 0 ? "lg:grid-cols-5" : "lg:grid-cols-4")}>
        <div className="card p-4"><Stat label="Money in" value={usd(t.received, true)} sub="donations, grants and bank receipts" /></div>
        <div className="card p-4"><Stat label="Money out" value={usd(t.spent, true)} sub="paid to suppliers and vendors" /></div>
        {t.returned > 0 && <div className="card p-4"><Stat label="Returned" value={usd(t.returned, true)} sub="refunds and carry-forwards" /></div>}
        <div className="card p-4"><Stat label="Still held" value={usd(t.balance, true)} sub={`across ${data.funds.length} fund${data.funds.length > 1 ? "s" : ""}`} /></div>
        <Link href="/untagged" className={clsx("card p-4 hover:border-brand", u.count > 0 && "border-[#f3d48a] bg-[#fffaf0]")}>
          <Stat label="Not yet traced" value={String(u.count)} sub={u.count ? `${usd(u.in)} in · ${usd(u.out)} out without a tracking code` : "every bank line is tagged to a fund"} />
        </Link>
      </div>

      <Section
        className="mt-6"
        title="From where to where"
        action={
          <div className="flex rounded-lg border border-line overflow-hidden text-xs font-semibold" role="group" aria-label="Group money out by">
            {(["category", "payee"] as const).map((k) => (
              <button key={k} onClick={() => setView(k)} aria-pressed={view === k} className={clsx("px-3 py-1.5", view === k ? "bg-brand-wash text-brand-ink" : "bg-surface text-ink-2")}>
                {k === "category" ? "By category" : "By payee"}
              </button>
            ))}
          </div>
        }
      >
        <div className="flex justify-between text-[11px] uppercase tracking-wide font-semibold text-muted mb-2 px-1">
          <span>Came from</span><span>Fund</span><span>Went to</span>
        </div>
        <Sankey graph={data.flow[view]} onFundClick={(slug) => router.push(`/funds/${slug}`)} ariaLabel={`Money flow: ${usd(t.received)} in, ${usd(t.spent)} out, ${usd(t.balance)} still held`} />
        <p className="text-xs text-muted mt-3">Band width is the amount of money. Colour shows which fund it passed through; grey is bank money with no tracking code yet. Hover for exact amounts, click a fund to open its trail.</p>
      </Section>

      <div className="grid lg:grid-cols-2 gap-6 mt-6">
        <PartyTable title="Biggest sources" parties={data.sources} sign="+" more={{ href: "/transactions?direction=in", label: "All money in" }} />
        <PartyTable title="Biggest payees" parties={data.payees} sign="−" more={{ href: "/transactions?direction=out", label: "All money out" }} />
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_400px] gap-6 mt-6">
        <div className="space-y-6 min-w-0">
          <section className="card overflow-x-auto">
            <div className="px-5 pt-4 pb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Funds</h2>
              <Link href="/funds" className="text-xs text-ink-2 hover:text-ink">All funds →</Link>
            </div>
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="text-left text-xs text-muted border-y border-line">
                  <th className="px-5 py-2 font-medium">Fund</th>
                  <th className="px-3 py-2 font-medium text-right">In</th>
                  <th className="px-3 py-2 font-medium text-right">Out</th>
                  <th className="px-5 py-2 font-medium text-right">Held</th>
                </tr>
              </thead>
              <tbody>
                {data.funds.map((f) => (
                  <tr key={f.id} className="border-b border-line last:border-0">
                    <td className="px-5 py-3">
                      <Link href={`/funds/${f.slug}`} className="font-medium hover:underline flex items-center gap-2"><span className="h-2 w-2 rounded-full shrink-0" style={{ background: f.accent }} />{f.title}</Link>
                      <div className="mt-1 flex flex-wrap gap-1.5 items-center">{f.codes.map((c) => <CodeChip key={c} code={c} />)}{f.status !== "active" && <StatusPill status={f.status} />}</div>
                    </td>
                    <td className="px-3 py-3 text-right tnum">{usd(f.received)}</td>
                    <td className="px-3 py-3 text-right tnum">{usd(f.spent + f.returned)}</td>
                    <td className="px-5 py-3 text-right tnum font-semibold">{usd(f.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <Section title="Money in vs money out" action={<span className="text-xs text-muted">Cumulative, all visible funds</span>}>
            <MoneyFlowChart entries={data.timeline} startedAt={data.timelineStart} />
          </Section>
        </div>

        <div className="space-y-6">
          <Section title="Latest movements" action={<Link href="/transactions" className="text-xs text-ink-2 hover:text-ink">Transactions →</Link>}>
            <MovementList rows={data.recent} />
          </Section>
          <div className={clsx("card p-4 flex gap-3 text-sm", !intact && "border-[#f0c4c4]")}>
            {intact ? <CheckCircle2 className="h-5 w-5 text-good shrink-0" /> : <AlertTriangle className="h-5 w-5 text-critical shrink-0" />}
            <div>
              <div className="font-medium">{intact ? "Records are intact" : "A record has been altered"}</div>
              <div className="text-xs text-ink-2 mt-0.5">
                {intact
                  ? `${data.integrity.ledgers} fund ledgers and ${data.integrity.auditEntries} audit-log entries pass their SHA-256 hash-chain checks.`
                  : [data.integrity.brokenLedgers.length ? `Ledger chain broken on ${data.integrity.brokenLedgers.join(", ")}.` : "", data.integrity.auditValid ? "" : "The audit-log chain is broken."].join(" ")}
                {" "}<Link href="/audit" className="underline">Audit log</Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
