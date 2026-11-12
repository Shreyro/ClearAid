"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AgCharts } from "ag-charts-react";
import { AllCommunityModule, ModuleRegistry, type AgCartesianChartOptions } from "ag-charts-community";
import { usd } from "./hooks";

ModuleRegistry.registerModules([AllCommunityModule]);

type Entry = { ts: string; type: string; amount: number };

/**
 * The app's colour tokens, read where the chart sits (an embed can redefine
 * them for its dark theme) and re-read when the device switches light/dark.
 * AG Charts draws on a canvas, so it needs real colours rather than var(--x).
 */
const TOKENS = ["series-1", "series-2", "ink", "ink-2", "muted", "line", "line-strong", "surface", "font-sans"] as const;
type Tokens = Record<(typeof TOKENS)[number], string>;
const FALLBACK: Tokens = { "series-1": "#2a78d6", "series-2": "#eb6834", ink: "#0b0b0b", "ink-2": "#3d3c38", muted: "#6f6d67", line: "#e7e6e0", "line-strong": "#cfcdc4", surface: "#ffffff", "font-sans": "system-ui, sans-serif" };

function useTokens() {
  const ref = useRef<HTMLDivElement>(null);
  const [tokens, setTokens] = useState<Tokens>(FALLBACK);
  useEffect(() => {
    const read = () => {
      if (!ref.current) return;
      const cs = getComputedStyle(ref.current);
      const next = { ...FALLBACK };
      for (const k of TOKENS) next[k] = cs.getPropertyValue(`--${k}`).trim() || FALLBACK[k];
      setTokens((prev) => (TOKENS.every((k) => prev[k] === next[k]) ? prev : next));
    };
    read();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", read);
    const mo = new MutationObserver(read);
    for (let el: HTMLElement | null = ref.current; el; el = el.parentElement) mo.observe(el, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    return () => {
      mq.removeEventListener("change", read);
      mo.disconnect();
    };
  }, []);
  return [ref, tokens] as const;
}

/** Shared look: transparent background, app font, recessive grid and axes. */
function base(t: Tokens): Pick<AgCartesianChartOptions, "background" | "padding" | "theme"> {
  return {
    background: { visible: false },
    padding: { top: 8, right: 8, bottom: 4, left: 4 },
    theme: {
      params: { fontFamily: t["font-sans"], fontSize: 12, foregroundColor: t.ink, textColor: t["ink-2"], subtleTextColor: t.muted, chromeTextColor: t.muted, axisLineColor: t["line-strong"], gridLineColor: t.line, chartBackgroundColor: t.surface, borderColor: t.line },
    },
  };
}

const tick = (cents: number) => {
  const d = cents / 100;
  return d >= 10000 ? `$${Math.round(d / 1000)}K` : `$${d.toLocaleString()}`;
};
const longDate = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export type FlowPoint = { t: number; raised: number; spent: number };

/** Cumulative money in vs money out for a fund, worked out from its ledger entries. */
export function MoneyFlowChart({ entries, startedAt }: { entries: Entry[]; startedAt: string }) {
  const points = useMemo(() => {
    const start = Date.parse(startedAt);
    // Span the chart from fund opening to the latest ledger event (keeps render pure).
    const end = Math.max(start + 86400_000, ...entries.map((e) => Date.parse(e.ts)));
    const days = Math.max(1, Math.ceil((end - start) / 86400_000));
    const out: FlowPoint[] = [];
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
        if (e.type === "bank_out" || e.type === "expense") spent += -e.amount;
        if (e.type === "refund" || e.type === "refund_reversed" || e.type === "carry_forward_out") raised += e.amount; // money returned leaves the pot (a reversal brings it back)
      }
      out.push({ t: Math.min(start + (d + 1) * 86400_000, end), raised, spent });
    }
    return out;
  }, [entries, startedAt]);
  return <CumulativeChart points={points} />;
}

/**
 * Running totals of money in and money out (AG Charts): two 2px lines on one
 * axis, a light area under money in, legend and a shared tooltip (AG Charts' crosshair is Enterprise-only).
 */
export function CumulativeChart({ points }: { points: FlowPoint[] }) {
  const [ref, t] = useTokens();
  const last = points[points.length - 1];
  const data = useMemo(() => points.map((p) => ({ t: new Date(p.t), raised: p.raised / 100, spent: p.spent / 100 })), [points]);
  const options = useMemo<AgCartesianChartOptions>(() => {
    const line = (key: "raised" | "spent", title: string, color: string) => ({
      type: "line" as const,
      xKey: "t",
      yKey: key,
      yName: title,
      stroke: color,
      strokeWidth: 2,
      marker: { enabled: false, fill: color, stroke: t.surface, strokeWidth: 2, size: 8 },
      tooltip: { renderer: ({ datum }: { datum: { t: Date; raised: number; spent: number } }) => ({ heading: longDate(datum.t.getTime()), title, data: [{ label: key === "raised" ? "In" : "Out", value: usd(Math.round(datum[key] * 100)) }] }) },
    });
    return {
      ...base(t),
      height: 240,
      data,
      series: [
        { type: "area", xKey: "t", yKey: "raised", fill: t["series-1"], fillOpacity: 0.08, strokeWidth: 0, showInLegend: false, tooltip: { enabled: false }, marker: { enabled: false } },
        line("raised", "Money in (net of refunds)", t["series-1"]),
        line("spent", "Money out", t["series-2"]),
      ],
      axes: {
        x: { type: "time", position: "bottom", nice: false, gridLine: { enabled: false }, label: { color: t.muted, format: "%b %-d" } },
        y: { type: "number", position: "left", nice: true, label: { color: t.muted, formatter: ({ value }: { value: number }) => tick(value * 100) } },
      },
      legend: { position: "top", item: { label: { color: t["ink-2"] }, marker: { shape: "square", size: 10 } } },
      tooltip: { mode: "shared" },
    } as AgCartesianChartOptions;
  }, [t, data]);
  return (
    <div ref={ref} className="w-full min-w-0" role="img" aria-label={`Cumulative money in ${usd(last?.raised ?? 0)} and money out ${usd(last?.spent ?? 0)}`}>
      <AgCharts options={options} />
    </div>
  );
}

export type BarRow = { key: string; label: string; amount: number; note?: string; muted?: boolean; capAmount?: number };

/**
 * One series as horizontal bars (AG Charts): value at the bar tip, share of
 * the total in the tooltip, optional cap marker per row, muted rows in grey.
 */
export function HBarChart({ rows, color = "series-1", of, ariaLabel, capLabel }: { rows: BarRow[]; color?: "series-1" | "series-2"; of: string; ariaLabel: string; capLabel?: string }) {
  const [ref, t] = useTokens();
  const total = rows.reduce((a, r) => a + r.amount, 0);
  const options = useMemo<AgCartesianChartOptions>(() => {
    const data = rows.map((r) => ({ label: r.label, value: r.amount / 100, cap: r.capAmount !== undefined ? r.capAmount / 100 : undefined, muted: Boolean(r.muted), note: r.note }));
    const hasCap = data.some((d) => d.cap !== undefined);
    const share = (v: number) => `${((v * 100) / Math.max(total, 1) * 100).toFixed(1)}% of ${of}`;
    return {
      ...base(t),
      height: Math.max(120, rows.length * (hasCap ? 56 : 38) + (hasCap ? 64 : 36)),
      data,
      series: [
        {
          type: "bar",
          direction: "horizontal",
          xKey: "label",
          yKey: "value",
          yName: of,
          fill: t[color],
          cornerRadius: 4,
          itemStyler: ({ datum }: { datum: { muted: boolean } }) => ({ fill: datum.muted ? t["line-strong"] : t[color] }),
          label: { enabled: true, placement: "outside-end", color: t.ink, fontWeight: 600, formatter: ({ value }: { value: number }) => usd(Math.round(value * 100)) },
          tooltip: { renderer: ({ datum }: { datum: { label: string; value: number; note?: string } }) => ({ heading: datum.label, data: [{ label: usd(Math.round(datum.value * 100)), value: share(datum.value) }, ...(datum.note ? [{ label: "", value: datum.note }] : [])] }) },
          showInLegend: hasCap,
        },
        ...(hasCap
          ? [
              {
                // The policy cap as a dashed outline beside the bar: how far spending may go.
                type: "bar" as const,
                direction: "horizontal" as const,
                xKey: "label",
                yKey: "cap",
                yName: capLabel ?? "Cap",
                fill: t.surface,
                fillOpacity: 0,
                stroke: t["ink-2"],
                strokeWidth: 1.5,
                lineDash: [4, 3],
                cornerRadius: 4,
                tooltip: { renderer: ({ datum }: { datum: { label: string; cap: number } }) => ({ heading: datum.label, data: [{ label: capLabel ?? "Cap", value: usd(Math.round(datum.cap * 100)) }] }) },
              },
            ]
          : []),
      ],
      axes: {
        x: { type: "category", position: "left", label: { color: t["ink-2"] }, line: { enabled: false } },
        y: { type: "number", position: "bottom", nice: true, label: { color: t.muted, formatter: ({ value }: { value: number }) => tick(value * 100) } },
      },
      legend: { enabled: hasCap, position: "bottom", item: { label: { color: t["ink-2"] } } },
    } as AgCartesianChartOptions;
  }, [t, rows, total, color, of, capLabel]);
  return (
    <div ref={ref} className="w-full min-w-0" role="img" aria-label={ariaLabel}>
      <AgCharts options={options} />
    </div>
  );
}

/** Spend by category: one series, so one hue; value at the bar tip; cap marker per category. */
export function CategoryBars({ rows }: { rows: { label: string; value: number; capPct?: number; raised: number }[] }) {
  if (!rows.length) return <div className="text-sm text-muted">No spending yet.</div>;
  return (
    <HBarChart
      rows={rows.map((r) => ({ key: r.label, label: r.label, amount: r.value, capAmount: r.capPct ? Math.round((r.capPct / 100) * r.raised) : undefined }))}
      of="spending"
      capLabel="Spending cap set by the fund's policy"
      ariaLabel={`Spending by category: ${rows.map((r) => `${r.label} ${usd(r.value)}`).join(", ")}`}
    />
  );
}
