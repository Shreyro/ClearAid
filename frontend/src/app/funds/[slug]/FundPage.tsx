"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { CalendarDays, Check, ChevronLeft, CodeXml, Copy, Download, ExternalLink, Landmark, Link2, MapPin, Receipt } from "lucide-react";
import clsx from "clsx";
import { useMe } from "@/components/AppShell";
import { ago, useJson, useLive, usd } from "@/components/hooks";
import { Section, Stat, StatusPill } from "@/components/ui";
import { CategoryBars, MoneyFlowChart } from "@/components/Charts";
import { LedgerGrid, type LedgerEntry } from "@/components/LedgerGrid";
import { CAT_LABEL } from "@/components/SpendCard";
import { CodeChip } from "@/components/banking";
import { Sankey, type FlowGraph } from "@/components/Sankey";
import { PartyTable, type Party } from "@/components/FlowParts";
import { CloseFund } from "@/components/CloseFund";

type Detail = {
  fund: {
    id: string;
    slug: string;
    title: string;
    region: string;
    description: string;
    status: string;
    startedAt: string;
    accent: string;
    trackingCodes: string[];
  };
  ngo: { name: string };
  stats: {
    raised: number;
    spent: number;
    refunded: number;
    carriedOut: number;
    balance: number;
    byCategory: Record<string, number>;
    chainValid: boolean;
  };
};
type Flow = {
  category: FlowGraph;
  payee: FlowGraph;
  sources: Party[];
  payees: Party[];
  evidence: { payments: number; withReceipt: number; missingAboveThreshold: number; threshold: number };
};

export function FundPage({ slug }: { slug: string }) {
  const { data, error, reload } = useJson<Detail>(`/api/funds/${slug}`);
  const { data: flow, reload: reloadFlow } = useJson<Flow>(`/api/funds/${slug}/flow`);
  const { data: ledger, reload: reloadLedger } = useJson<{ entries: LedgerEntry[] }>(`/api/funds/${slug}/ledger`);
  const [view, setView] = useState<"category" | "payee">("payee");
  const { me } = useMe();
  const isAdmin = me.role === "admin";
  const isDonor = me.role === "donor";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void reload();
      void reloadFlow();
      void reloadLedger();
    }, 250);
  }, [reload, reloadFlow, reloadLedger]);

  const live = useLive(data?.fund.id ?? null, refresh);

  if (error)
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <p className="text-ink-2">{error}</p>
        <Link href="/funds" className="btn btn-ghost mt-4">Back to funds</Link>
      </div>
    );
  if (!data) return <div className="mx-auto max-w-6xl px-4 py-10"><div className="card h-48 animate-pulse" /></div>;

  const { fund, stats, ngo } = data;
  const returned = stats.refunded + stats.carriedOut;
  const catRows = Object.entries(stats.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: CAT_LABEL[k] ?? k, value: v, raised: stats.raised }));

  return (
    <div>
      <div className="border-b border-line bg-surface">
        <div className="h-1" style={{ background: fund.accent }} />
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-6">
          <Link href="/funds" className="text-xs text-muted hover:text-ink inline-flex items-center gap-0.5 mb-2"><ChevronLeft className="h-3.5 w-3.5" /> Funds</Link>
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
            <span className="font-medium text-ink">{ngo.name}</span>
            {fund.status !== "active" && <StatusPill status={fund.status} />}
            {fund.trackingCodes.map((c) => <CodeChip key={c} code={c} />)}
          </div>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight mt-3 max-w-3xl">{fund.title}</h1>
          <div className="flex flex-wrap gap-4 mt-3 text-sm text-ink-2">
            <span className="inline-flex items-center gap-1"><MapPin className="h-4 w-4" /> {fund.region}</span>
            <span className="inline-flex items-center gap-1"><CalendarDays className="h-4 w-4" /> Opened {ago(fund.startedAt)}</span>
            <span className={clsx("inline-flex items-center gap-1", !stats.chainValid && "text-critical")}><Link2 className="h-4 w-4" /> {stats.chainValid ? "Ledger hash chain verified" : "Ledger hash chain broken"}</span>
            <span className="inline-flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${live ? "bg-good live-dot" : "bg-line-strong"}`} /> {live ? "Live" : "Connecting…"}</span>
          </div>
          {fund.description && <p className="mt-4 text-ink-2 max-w-3xl">{fund.description}</p>}
        </div>
      </div>

      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-6 space-y-6">
        <div className={clsx("grid grid-cols-2 gap-4", returned > 0 ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
          <div className="card p-4"><Stat label="Money in" value={usd(stats.raised, true)} sub={`from ${flow ? flow.sources.length : "…"} payers`} /></div>
          <div className="card p-4"><Stat label="Money out" value={usd(stats.spent, true)} sub={`to ${flow ? flow.payees.length : "…"} payees`} /></div>
          {returned > 0 && <div className="card p-4"><Stat label={stats.refunded ? "Returned" : "Moved to other funds"} value={usd(returned, true)} sub={stats.refunded ? "refunds and moves to other funds" : "leftover money, moved by an admin"} /></div>}
          <div className="card p-4"><Stat label="Still held" value={usd(stats.balance, true)} sub={fund.status === "closed" ? (stats.balance ? "in the bank, after closure" : "nothing left") : stats.raised ? `${Math.round((stats.balance / stats.raised) * 100)}% of money in` : "—"} /></div>
        </div>

        <Section
          title="From where to where"
          action={
            <div className="flex rounded-lg border border-line overflow-hidden text-xs font-semibold" role="group" aria-label="Group money out by">
              {(["payee", "category"] as const).map((k) => (
                <button key={k} onClick={() => setView(k)} aria-pressed={view === k} className={clsx("px-3 py-1.5", view === k ? "bg-brand-wash text-brand-ink" : "bg-surface text-ink-2")}>
                  {k === "category" ? "By category" : "By payee"}
                </button>
              ))}
            </div>
          }
        >
          {flow ? <Sankey graph={flow[view]} ariaLabel={`${fund.title}: ${usd(stats.raised)} in, ${usd(stats.spent)} out, ${usd(stats.balance)} held`} /> : <div className="h-80" />}
        </Section>

        <div className="grid lg:grid-cols-2 gap-6">
          <PartyTable title="Where it came from" parties={flow?.sources.slice(0, 10) ?? []} sign="+" more={{ href: `/transactions?fund=${fund.id}&direction=in`, label: "All money in" }} />
          <PartyTable title="Where it went" parties={flow?.payees.slice(0, 10) ?? []} sign="−" more={{ href: `/transactions?fund=${fund.id}&direction=out`, label: "All money out" }} />
        </div>

        <CollectMoney slug={fund.slug} title={fund.title} code={fund.trackingCodes[0]} open={fund.status === "active"} />

        {isAdmin && (
          <div className="card p-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="font-semibold">Show this fund on your website.</span> <span className="text-ink-2">Publish the numbers you choose as an embed that stays up to date. Nothing else leaves ClearAid.</span>
            </p>
            <Link className="btn btn-ghost" href={`/settings?tab=publish&fund=${fund.id}`}><CodeXml className="h-4 w-4" /> Create an embed</Link>
          </div>
        )}

        {isAdmin && <CloseFund fundId={fund.id} title={fund.title} stamp={ledger?.entries.length} onDone={refresh} />}

        <div className="grid md:grid-cols-2 gap-6">
          <Section title="Money in vs money out">
            {ledger ? <MoneyFlowChart entries={ledger.entries} startedAt={fund.startedAt} /> : <div className="h-56" />}
          </Section>
          <Section
            title="Spending by category"
            action={
              flow && flow.evidence.payments > 0 ? (
                isDonor ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-ink-2">
                    <Receipt className="h-3.5 w-3.5" /> {flow.evidence.withReceipt}/{flow.evidence.payments} payments have a receipt
                    {flow.evidence.missingAboveThreshold > 0 && ` · ${flow.evidence.missingAboveThreshold} missing`}
                  </span>
                ) : (
                  <Link
                    href="/untagged?status=receipts"
                    className={clsx("inline-flex items-center gap-1 text-xs font-semibold", flow.evidence.missingAboveThreshold ? "text-warn-ink" : "text-ink-2")}
                    title={`Bank payments of ${usd(flow.evidence.threshold)} or more should have a receipt`}
                  >
                    <Receipt className="h-3.5 w-3.5" /> {flow.evidence.withReceipt}/{flow.evidence.payments} payments have a receipt
                    {flow.evidence.missingAboveThreshold > 0 && ` · ${flow.evidence.missingAboveThreshold} missing`}
                  </Link>
                )
              ) : null
            }
          >
            <CategoryBars rows={catRows} />
          </Section>
        </div>

        <Section
          title={`Ledger (${ledger?.entries.length ?? "…"} entries)`}
          action={<a href={`/api/transactions?fund=${fund.id}&format=csv`} className="btn btn-ghost !py-1 text-xs"><Download className="h-3.5 w-3.5" /> CSV</a>}
        >
          {ledger ? <LedgerGrid entries={ledger.entries} fundId={fund.id} /> : null}
        </Section>
      </div>
    </div>
  );
}

/** The fund's public donation link and bank-transfer reference, so new money arrives already tagged. */
function CollectMoney({ slug, title, code, open }: { slug: string; title: string; code?: string; open: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const link = `${origin}/give/${slug}`;
  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked: the field is selectable instead */
    }
  }
  if (!open) return null;
  return (
    <Section title="Collect money for this fund">
      <div className="grid md:grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="text-sm font-semibold flex items-center gap-1.5"><Link2 className="h-4 w-4" /> Donation link</div>
          <p className="text-xs text-ink-2 mt-1">
            Share it anywhere. Gifts go through PayPal with {code ? <span className="font-mono">#{code}</span> : "this fund"} attached and land on this ledger straight away.
          </p>
          <div className="mt-3 flex gap-2">
            <input readOnly className="input !py-1.5 text-xs font-mono flex-1 min-w-0" value={link} aria-label={`Donation link for ${title}`} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn btn-ghost !py-1 text-xs" onClick={() => copy("link", link)}>
              {copied === "link" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied === "link" ? "Copied" : "Copy"}
            </button>
            <a className="btn btn-ghost !py-1 text-xs" href={`/give/${slug}`} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /> Open</a>
          </div>
        </div>
        <div className="card p-4">
          <div className="text-sm font-semibold flex items-center gap-1.5"><Landmark className="h-4 w-4" /> Bank transfer reference</div>
          {code ? (
            <>
              <p className="text-xs text-ink-2 mt-1">Ask payers to put this in the transfer reference. Lines carrying it are tagged to this fund when the statement is imported.</p>
              <div className="mt-3 flex items-center gap-2">
                <span className="font-mono text-lg font-semibold">#{code}</span>
                <button className="btn btn-ghost !py-1 text-xs" onClick={() => copy("code", `#${code}`)}>
                  {copied === "code" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied === "code" ? "Copied" : "Copy"}
                </button>
              </div>
            </>
          ) : (
            <p className="text-xs text-ink-2 mt-1">This fund has no tracking code yet. <Link href="/settings?tab=funds" className="underline">Add one in Settings</Link> so bank transfers can be matched to it.</p>
          )}
        </div>
      </div>
    </Section>
  );
}
