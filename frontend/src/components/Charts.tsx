"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import { usd, shortDate } from "./hooks";

type Entry = { ts: string; type: string; amount: number };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const niceMax = (v: number) => {
  if (v <= 0) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};
const tick = (cents: number) => {
  const d = cents / 100;
  return d >= 10000 ? `$${Math.round(d / 1000)}K` : `$${d.toLocaleString()}`;
};

export type FlowPoint = { t: number; raised: number; spent: number };

/** Cumulative money in vs money out for a fund, worked out from its ledger entries. */
export function MoneyFlowChart({ entries, startedAt }: { entries: Entry[]; startedAt: string }) {
  const points = useMemo(() => {
    const start = Date.parse(startedAt);
    // Span the chart from fund opening to the latest ledger event (keeps render pure).
    const end = Math.max(start + 86400_000, ...entries.map((e) => Date.parse(e.ts)));
    const days = Math.max(1, Math.ceil((end - start) / 86400_000));
    const out: { t: number; raised: number; spent: number }[] = [];
    let raised = 0;
    let spent = 0;
    const sorted = [...entries].sort((a, b) => a.ts.localeCompare(b.ts));
    let i = 0;
    for (let d = 0; d < days; d++) {
      const dayEnd = start + (d + 1) * 86400_000;
      while (i < sorted.length && Date.parse(sorted[i].ts) < dayEnd) {
        const e = sorted[i++];
        if (e.type === "donation" || e.type === "carry_forward_in") raised += e.amount;
        if (e.type === "withdrawal") spent += -e.amount;
        // Bank lines are signed; a retag posts a reversing entry, so add them as-is.
        if (e.type === "bank_in") raised += e.amount;
        if (e.type === "bank_out") spent += -e.amount;
        if (e.type === "refund" || e.type === "carry_forward_out") raised += e.amount; // money returned leaves the pot
      }
      out.push({ t: Math.min(start + (d + 1) * 86400_000, end), raised, spent });
    }
    return out;
  }, [entries, startedAt]);
  return <CumulativeChart points={points} />;
}

/**
 * Running totals of money in and money out. Two series, one axis, crosshair
 * tooltip, legend + direct end labels (dataviz spec: 2px lines, recessive grid).
 */
export function CumulativeChart({ points }: { points: FlowPoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 220;
  const pad = { l: 52, r: 92, t: 12, b: 26 };

  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const max = niceMax(Math.max(...points.map((p) => Math.max(p.raised, p.spent)), 1));
  const x = (i: number) => pad.l + (points.length > 1 ? (i / (points.length - 1)) * iw : 0);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const path = (k: "raised" | "spent") => points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
  const area = `${path("raised")}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const last = points[points.length - 1];
  const hp = hover !== null ? points[hover] : null;

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1)))));
  }

  return (
    <div ref={ref} className="relative w-full min-w-0">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2 mb-2" aria-hidden>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: "var(--series-1)" }} /> Money in (net of refunds)</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: "var(--series-2)" }} /> Money out</span>
      </div>
      <svg width={width} height={height} role="img" aria-label={`Cumulative money in ${usd(last?.raised ?? 0)} and money out ${usd(last?.spent ?? 0)}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={pad.l + iw} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--line-strong)" : "#ecebe5"} />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)" className="tnum">{tick(t)}</text>
          </g>
        ))}
        {[0, Math.floor((points.length - 1) / 2), points.length - 1].map((i) => (
          <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} fontSize={11} fill="var(--muted)">
            {shortDate(new Date(points[i].t).toISOString())}
          </text>
        ))}
        <path d={area} fill="var(--series-1)" opacity={0.08} />
        <path d={path("raised")} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <path d={path("spent")} fill="none" stroke="var(--series-2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {last && (
          <>
            <circle cx={x(points.length - 1)} cy={y(last.raised)} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
            <circle cx={x(points.length - 1)} cy={y(last.spent)} r={4} fill="var(--series-2)" stroke="var(--surface)" strokeWidth={2} />
            <text x={x(points.length - 1) + 8} y={y(last.raised) + 4} fontSize={12} fontWeight={600} fill="var(--ink)" className="tnum">{usd(last.raised, true)}</text>
            <text x={x(points.length - 1) + 8} y={Math.max(y(last.spent) + 4, y(last.raised) + 20)} fontSize={12} fontWeight={600} fill="var(--ink-2)" className="tnum">{usd(last.spent, true)}</text>
          </>
        )}
        {hp && hover !== null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--line-strong)" />
            <circle cx={x(hover)} cy={y(hp.raised)} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
            <circle cx={x(hover)} cy={y(hp.spent)} r={4} fill="var(--series-2)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
        <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hp && hover !== null && (
        <div className="pointer-events-none absolute top-8 card shadow-lg px-3 py-2 text-xs" style={{ left: Math.min(x(hover) + 12, width - 170) }}>
          <div className="text-muted mb-1">{new Date(hp.t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
          <div className="flex items-center gap-2"><span className="h-0.5 w-3" style={{ background: "var(--series-1)" }} /><b className="tnum">{usd(hp.raised)}</b> <span className="text-ink-2">in</span></div>
          <div className="flex items-center gap-2"><span className="h-0.5 w-3" style={{ background: "var(--series-2)" }} /><b className="tnum">{usd(hp.spent)}</b> <span className="text-ink-2">out</span></div>
        </div>
      )}
    </div>
  );
}

/** Spend by category: one series, so one hue; value at the bar tip; cap marker per category. */
export function CategoryBars({ rows }: { rows: { label: string; value: number; capPct?: number; raised: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...rows.map((r) => Math.max(r.value, r.capPct ? (r.capPct / 100) * r.raised : 0)), 1);
  const total = rows.reduce((a, r) => a + r.value, 0);
  if (!rows.length) return <div className="text-sm text-muted">No spending yet.</div>;
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => {
        const capX = r.capPct ? ((r.capPct / 100) * r.raised) / max : null;
        return (
          <li key={r.label} className="relative" onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} tabIndex={0} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
            <div className="flex justify-between text-sm">
              <span className="text-ink-2">{r.label}</span>
              <span className="font-semibold tnum">{usd(r.value)}</span>
            </div>
            <div className="relative h-3 mt-1">
              <div className="absolute inset-y-0 left-0 rounded-r" style={{ width: `${(r.value / max) * 100}%`, background: "var(--series-1)", opacity: hover === null || hover === i ? 1 : 0.55, borderRadius: "0 4px 4px 0" }} />
              {capX !== null && <div className="absolute -top-0.5 -bottom-0.5 w-px bg-ink-2" style={{ left: `${capX * 100}%` }} title={`Policy cap ${r.capPct}%`} />}
            </div>
            {hover === i && (
              <div className="absolute right-0 -top-9 card shadow px-2.5 py-1.5 text-xs z-10 whitespace-nowrap">
                <b className="tnum">{((r.value / Math.max(total, 1)) * 100).toFixed(1)}%</b> <span className="text-ink-2">of spending{r.capPct ? ` · cap ${r.capPct}% of raised` : ""}</span>
              </div>
            )}
          </li>
        );
      })}
      {rows.some((r) => r.capPct) && <li className="text-[11px] text-muted pt-1 flex items-center gap-1.5"><span className="inline-block w-px h-3 bg-ink-2" /> Spending cap set by the fund&apos;s policy</li>}
    </ul>
  );
}
