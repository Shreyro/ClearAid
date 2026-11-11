"use client";

import { useState } from "react";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, MapPin, ShieldCheck } from "lucide-react";
import clsx from "clsx";
import { usd } from "./hooks";
import { DonateForm } from "./DonateForm";
import { CumulativeChart } from "./Charts";
import { Sankey, type FlowGraph } from "./Sankey";
import type { EmbedTheme } from "./embedTheme";
import { Pill, Stat } from "./ui";

/** The public response for one embed (EmbedPayload in backend/src/lib/embed.ts). Blocks that aren't published are absent. */
export type EmbedData = {
  /** "combined" when two or more funds are published together. */
  scope?: "combined";
  /** Colours chosen by the admin; the page wraps the widget in the matching theme class. */
  theme?: EmbedTheme;
  fund: { title: string; region: string; status: string; accent: string };
  ngo: { name: string };
  asOf: string;
  totals?: { in: number; out: number; returned: number; held: number };
  sources?: { id: string; label: string; amount: number }[];
  categories?: { id: string; label: string; amount: number }[];
  payees?: { name: string; amount: number; payments: number; other?: boolean }[];
  flow?: FlowGraph;
  timeline?: { date: string; in: number; out: number }[];
  activity?: { date: string; direction: "in" | "out"; label: string; detail?: string; payee?: string; amount: number; fund?: string }[];
  integrity?: { valid: boolean; entries: number; head: string | null; ledgers?: number };
  funds?: { title: string; status: string; accent: string; in: number; out: number; held: number }[];
  /** The donate form: the published funds still taking donations. */
  donate?: { funds: { slug: string; title: string; accent: string; code: string | null; returns: boolean }[] };
};

/** Give to one of the embed's open funds, through that fund's own donation link. */
function DonateBlock({ funds, preview }: { funds: NonNullable<EmbedData["donate"]>["funds"]; preview?: boolean }) {
  const [slug, setSlug] = useState(funds[0]?.slug ?? "");
  const current = funds.find((f) => f.slug === slug) ?? funds[0];
  if (!current) return <p className="text-sm text-muted">No fund is taking donations right now.</p>;
  return (
    <div className="space-y-4">
      {funds.length > 1 && (
        <div>
          <label className="label" htmlFor="donate-fund">Give to</label>
          <select id="donate-fund" className="input" value={current.slug} onChange={(e) => setSlug(e.target.value)}>
            {funds.map((f) => <option key={f.slug} value={f.slug}>{f.title}</option>)}
          </select>
        </div>
      )}
      <DonateForm key={current.slug} slug={current.slug} preview={preview} compact />
    </div>
  );
}

// Day-only dates are published in UTC; show them as that day wherever the reader is.
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

type Bar = { key: string; label: string; amount: number; note?: string; muted?: boolean };

/** One series as horizontal bars: label and exact value in text, bar for comparison, share of the total on hover. */
function BarList({ rows, color, of, empty }: { rows: Bar[]; color: string; of: string; empty: string }) {
  const [hover, setHover] = useState<string | null>(null);
  if (!rows.length) return <p className="text-sm text-muted">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.amount), 1);
  const total = rows.reduce((a, r) => a + r.amount, 0);
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key} className="relative outline-none" tabIndex={0} onPointerEnter={() => setHover(r.key)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(r.key)} onBlur={() => setHover(null)}>
          <div className="flex justify-between gap-3 text-sm">
            <span className="text-ink-2 truncate" title={r.label}>{r.label}</span>
            <span className="font-semibold tnum shrink-0">{usd(r.amount)}</span>
          </div>
          <div className="h-3 mt-1">
            <div className="h-full" style={{ width: `${Math.max((r.amount / max) * 100, 0.5)}%`, background: r.muted ? "var(--line-strong)" : color, opacity: hover === null || hover === r.key ? 1 : 0.55, borderRadius: "0 4px 4px 0" }} />
          </div>
          {r.note && <div className="text-xs text-muted mt-1">{r.note}</div>}
          {hover === r.key && (
            <div className="pointer-events-none absolute right-0 -top-8 card shadow px-2.5 py-1.5 text-xs z-10 whitespace-nowrap">
              <b className="tnum">{((r.amount / Math.max(total, 1)) * 100).toFixed(1)}%</b> <span className="text-ink-2">of {of}</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** One side of the flow diagram as bar rows: what came in, or where it went (spending first, then money returned or still held). Adds up across funds. */
function flowRows(flow: FlowGraph, side: "in" | "out"): Bar[] {
  const label = new Map(flow.nodes.map((n) => [n.id, n.label]));
  const spend = (id: string) => id.startsWith("dst:cat:") || id === "dst:fees";
  const totals = new Map<string, number>();
  for (const l of flow.links) {
    const id = side === "in" ? l.source : l.target;
    if (id.startsWith(side === "in" ? "src:" : "dst:")) totals.set(id, (totals.get(id) ?? 0) + l.value);
  }
  return [...totals]
    .map(([id, amount]) => ({ key: id, label: label.get(id) ?? "Other", amount, muted: side === "in" ? id === "src:deficit" : !spend(id) }))
    .sort((a, b) => Number(a.muted) - Number(b.muted) || b.amount - a.amount);
}

function Block({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={clsx("min-w-0", className)}>
      <h2 className="text-sm font-semibold mb-3">{title}</h2>
      {children}
    </section>
  );
}

/**
 * A fund's published numbers. This is the whole public widget: it draws only
 * what the response contains, and is used both on the public embed page and
 * for the preview an admin sees before publishing. Layout follows the width of
 * the box it is in (container queries), not the browser window.
 */
export function EmbedView({ data, preview }: { data: EmbedData; preview?: boolean }) {
  const { fund, ngo, totals, sources, categories, payees, flow, timeline, activity, integrity, funds, donate } = data;
  const combined = data.scope === "combined";
  const asOf = new Date(data.asOf).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const overspent = totals ? totals.held < 0 : false;

  return (
    <article className="@container card overflow-hidden text-ink">
      <div className="h-1.5" style={{ background: fund.accent }} />
      <div className="p-5 @lg:p-6 space-y-6">
        <header>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
            {ngo.name && <span className="font-medium text-ink">{ngo.name}</span>}
            {fund.region && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" aria-hidden /> {fund.region}</span>}
            {fund.status !== "active" && <Pill>{fund.status === "closed" ? "Closed" : "Closing"}</Pill>}
          </div>
          <h1 className="text-xl @lg:text-2xl font-semibold tracking-tight mt-1">{fund.title}</h1>
        </header>

        {totals && (
          <div className={clsx("grid grid-cols-2 gap-x-4 gap-y-4", totals.returned > 0 ? "@xl:grid-cols-4" : "@md:grid-cols-3")}>
            <Stat label="Money in" value={usd(totals.in, true)} />
            <Stat label="Money out" value={usd(totals.out, true)} sub={totals.in > 0 ? `${Math.round((totals.out / totals.in) * 100)}% of money in` : undefined} />
            {totals.returned > 0 && <Stat label="Returned" value={usd(totals.returned, true)} sub="refunds and carry-forwards" />}
            <Stat label={overspent ? "Overspent" : "Still held"} value={usd(Math.abs(totals.held), true)} sub={overspent ? "paid out ahead of money in" : undefined} />
          </div>
        )}

        {donate && (
          <Block title="Donate">
            <DonateBlock funds={donate.funds} preview={preview} />
          </Block>
        )}

        {funds && (
          <Block title="Fund by fund">
            <ul className="divide-y divide-line">
              {funds.map((f) => (
                <li key={f.title} className="py-2.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                  <span className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: f.accent }} aria-hidden />
                    <span className="truncate font-medium" title={f.title}>{f.title}</span>
                    {f.status !== "active" && <Pill>{f.status === "closed" ? "Closed" : "Closing"}</Pill>}
                  </span>
                  <span className="text-xs text-ink-2 tnum">
                    In <b className="text-ink">{usd(f.in, true)}</b> · Out <b className="text-ink">{usd(f.out, true)}</b> · {f.held < 0 ? "Overspent" : "Held"} <b className="text-ink">{usd(Math.abs(f.held), true)}</b>
                  </span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {flow && (
          <>
            {/* The diagram needs room; in a narrow column (a phone) the same totals are listed instead. */}
            <Block title="From where to where" className="hidden @min-[38rem]:block">
              <Sankey graph={combined ? flow : { ...flow, nodes: flow.nodes.map((n) => (n.kind === "fund" ? { ...n, label: "This fund" } : n)) }} compact ariaLabel={`${fund.title}: where the money came from and where it went`} />
            </Block>
            {(!sources || !categories) && (
              <div className="grid gap-6 @min-[38rem]:hidden">
                {!sources && (
                  <Block title="Where the money came from">
                    <BarList rows={flowRows(flow, "in")} color="var(--series-1)" of="money in" empty="No money has come in yet." />
                  </Block>
                )}
                {!categories && (
                  <Block title="Where it went">
                    <BarList rows={flowRows(flow, "out")} color="var(--series-2)" of="money in" empty="Nothing has gone out yet." />
                  </Block>
                )}
              </div>
            )}
          </>
        )}

        {(sources || categories) && (
          <div className={clsx("grid gap-6", sources && categories && "@2xl:grid-cols-2")}>
            {sources && (
              <Block title="Where the money came from">
                <BarList rows={sources.map((s) => ({ key: s.id, label: s.label, amount: s.amount }))} color="var(--series-1)" of="money in" empty="No money has come in yet." />
              </Block>
            )}
            {categories && (
              <Block title="What it was spent on">
                <BarList rows={categories.map((c) => ({ key: c.id, label: c.label, amount: c.amount }))} color="var(--series-2)" of="spending" empty="Nothing has been spent yet." />
              </Block>
            )}
          </div>
        )}

        {payees && (
          <Block title="Who was paid">
            <BarList
              rows={payees.map((p) => ({ key: p.name, label: p.name, amount: p.amount, muted: p.other, note: `${p.payments} payment${p.payments === 1 ? "" : "s"}` }))}
              color="var(--series-2)"
              of="payments"
              empty="No payments yet."
            />
          </Block>
        )}

        {timeline && (
          <Block title="Money in and out over time">
            <CumulativeChart points={timeline.map((p) => ({ t: Date.parse(`${p.date}T12:00:00Z`), raised: p.in, spent: p.out }))} />
          </Block>
        )}

        {activity && (
          <Block title="Latest movements">
            {activity.length === 0 ? (
              <p className="text-sm text-muted">No money has moved yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {activity.map((m, i) => (
                  <li key={i} className="flex items-start gap-3 py-2 text-sm">
                    {m.direction === "in" ? <ArrowDownLeft className="h-4 w-4 mt-0.5 shrink-0 text-ink-2" aria-label="Money in" /> : <ArrowUpRight className="h-4 w-4 mt-0.5 shrink-0 text-ink-2" aria-label="Money out" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate" title={m.payee ? `${m.label} · ${m.payee}` : m.label}>
                        {m.label}
                        {m.payee && <span className="text-ink-2"> · {m.payee}</span>}
                      </div>
                      <div className="text-xs text-muted">{day(m.date)}{m.fund ? ` · ${m.fund}` : ""}{m.detail ? ` · ${m.detail}` : ""}</div>
                    </div>
                    <span className="tnum font-semibold shrink-0">{m.direction === "in" ? "+" : "−"}{usd(m.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Block>
        )}

        <footer className="border-t border-line pt-4 space-y-1.5 text-xs text-ink-2">
          {integrity && (
            <div className="flex items-start gap-1.5">
              {integrity.valid ? <ShieldCheck className="h-4 w-4 shrink-0 text-good" aria-hidden /> : <AlertTriangle className="h-4 w-4 shrink-0 text-critical" aria-hidden />}
              <span>
                {integrity.valid ? (
                  <>
                    <span className="font-semibold text-ink">{integrity.ledgers ? `All ${integrity.ledgers} ledgers verified.` : "Ledger verified."}</span> {integrity.entries.toLocaleString("en-US")} entries, each chained to the one before it by its hash, so past entries can&apos;t be changed unnoticed.
                    {integrity.head && <> Latest hash <span className="font-mono text-ink" title={integrity.head}>{integrity.head.slice(0, 12)}…</span></>}
                  </>
                ) : (
                  <><span className="font-semibold text-ink">Ledger check failed.</span> {integrity.ledgers ? "At least one fund's hash chain doesn't verify." : <>The hash chain of this fund&apos;s {integrity.entries.toLocaleString("en-US")} entries doesn&apos;t verify.</>}</>
                )}
              </span>
            </div>
          )}
          <div className="text-muted">Figures as of {asOf}{ngo.name ? `, published by ${ngo.name}` : ""}. Tracked with ClearAid.</div>
        </footer>
      </div>
    </article>
  );
}
