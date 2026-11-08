"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usd } from "./hooks";

export type FlowNode = { id: string; label: string; column: 0 | 1 | 2; kind: "source" | "fund" | "untraced" | "dest"; color?: string; slug?: string };
export type FlowLink = { source: string; target: string; value: number };
export type FlowGraph = { nodes: FlowNode[]; links: FlowLink[] };

const NEUTRAL = "#8d8b84";
const UNTRACED = "#b7b5ad";
const NODE_W = 12;
const GAP = 10;
const LABEL_L = 176;
const LABEL_R = 196;
const MIN_W = 680;

// Destinations that close the flow sit at the bottom: returned money, fees, untagged, then what's still held.
function destRank(n: FlowNode) {
  if (n.id === "dst:balance" || n.id === "dst:untraced_balance" || n.label === "Still held in funds" || n.label === "Untraced, still in the bank") return 3;
  if (["dst:refund", "dst:carry", "dst:fees", "dst:untagged"].includes(n.id) || ["Refunded to donors", "Carried to other funds", "Bank fees"].includes(n.label)) return 2;
  if (n.label === "Other payees" || n.id === "dst:cat:none") return 1;
  return 0;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Placed = FlowNode & { x: number; y: number; h: number; inV: number; outV: number; value: number };
type PlacedLink = FlowLink & { d: string; w: number; color: string; key: string };

/**
 * Sources → funds → destinations, with band width proportional to money.
 * Fund nodes carry each fund's identity colour; sources and destinations are
 * neutral so colour always means "which fund". Hover any band or node for
 * exact amounts; click a fund to open its trail.
 */
export function Sankey({ graph, onFundClick, ariaLabel }: { graph: FlowGraph; onFundClick?: (slug: string) => void; ariaLabel: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<{ kind: "link" | "node"; id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(MIN_W, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    const byId = new Map<string, Placed>();
    for (const n of graph.nodes) byId.set(n.id, { ...n, x: 0, y: 0, h: 0, inV: 0, outV: 0, value: 0 });
    const links = graph.links.filter((l) => l.value > 0 && byId.has(l.source) && byId.has(l.target));
    for (const l of links) {
      byId.get(l.source)!.outV += l.value;
      byId.get(l.target)!.inV += l.value;
    }
    const placed = [...byId.values()].filter((n) => n.inV + n.outV > 0);
    for (const n of placed) n.value = Math.max(n.inV, n.outV);

    const cols: Placed[][] = [0, 1, 2].map((c) => placed.filter((n) => n.column === c));
    cols[0].sort((a, b) => Number(a.id === "src:deficit") - Number(b.id === "src:deficit") || b.value - a.value);
    cols[1].sort((a, b) => Number(a.kind === "untraced") - Number(b.kind === "untraced") || b.value - a.value);
    cols[2].sort((a, b) => destRank(a) - destRank(b) || b.value - a.value);

    const maxCount = Math.max(...cols.map((c) => c.length), 1);
    const height = Math.max(320, maxCount * 34 + 20);
    const k = Math.min(...cols.filter((c) => c.length).map((c) => (height - GAP * (c.length - 1)) / c.reduce((a, n) => a + n.value, 0)));
    const xs = [LABEL_L, Math.round((LABEL_L + width - LABEL_R - NODE_W) / 2), width - LABEL_R - NODE_W];
    cols.forEach((col, ci) => {
      const used = col.reduce((a, n) => a + Math.max(2, n.value * k), 0) + GAP * Math.max(0, col.length - 1);
      let y = (height - used) / 2;
      for (const n of col) {
        n.x = xs[ci];
        n.y = y;
        n.h = Math.max(2, n.value * k);
        y += n.h + GAP;
      }
    });

    // Stack bands on each node in the order of the node at the other end, so bands don't cross needlessly.
    const outOff = new Map<string, number>();
    const inOff = new Map<string, number>();
    const sorted = [...links].sort((a, b) => byId.get(a.source)!.y - byId.get(b.source)!.y || byId.get(a.target)!.y - byId.get(b.target)!.y);
    const outOrder = [...links].sort((a, b) => byId.get(a.target)!.y - byId.get(b.target)!.y);
    const outStart = new Map<FlowLink, number>();
    for (const l of outOrder) {
      const o = outOff.get(l.source) ?? 0;
      outStart.set(l, o);
      outOff.set(l.source, o + l.value * k);
    }
    const placedLinks: PlacedLink[] = sorted.map((l) => {
      const s = byId.get(l.source)!;
      const t = byId.get(l.target)!;
      const w = Math.max(1, l.value * k);
      const ti = inOff.get(l.target) ?? 0;
      inOff.set(l.target, ti + l.value * k);
      const x0 = s.x + NODE_W;
      const x1 = t.x;
      const y0 = s.y + outStart.get(l)! + w / 2;
      const y1 = t.y + ti + w / 2;
      const xm = (x0 + x1) / 2;
      const fund = s.column === 1 ? s : t;
      const color = fund.kind === "untraced" ? UNTRACED : fund.color ?? NEUTRAL;
      return { ...l, w, color, key: `${l.source}→${l.target}`, d: `M${x0},${y0}C${xm},${y0} ${xm},${y1} ${x1},${y1}` };
    });
    return { nodes: placed, links: placedLinks, height, byId };
  }, [graph, width]);

  if (!layout.nodes.length) return <div className="text-sm text-muted py-10 text-center">No money has moved yet.</div>;

  const active = (l: PlacedLink) => !hover || (hover.kind === "link" ? hover.id === l.key : l.source === hover.id || l.target === hover.id);
  const hl = hover?.kind === "link" ? layout.links.find((l) => l.key === hover.id) : null;
  const hn = hover?.kind === "node" ? layout.byId.get(hover.id) : null;
  const point = (e: React.PointerEvent, kind: "link" | "node", id: string) => {
    const r = ref.current!.getBoundingClientRect();
    setHover({ kind, id, x: e.clientX - r.left + ref.current!.scrollLeft, y: e.clientY - r.top });
  };

  return (
    <div ref={ref} className="relative w-full overflow-x-auto" onPointerLeave={() => setHover(null)}>
      <svg width={width} height={layout.height} role="img" aria-label={ariaLabel} className="block">
        <g fill="none">
          {layout.links.map((l) => (
            <path
              key={l.key}
              d={l.d}
              stroke={l.color}
              strokeWidth={l.w}
              strokeOpacity={hover ? (active(l) ? 0.6 : 0.1) : 0.32}
              onPointerMove={(e) => point(e, "link", l.key)}
              style={{ transition: "stroke-opacity 120ms" }}
            />
          ))}
        </g>
        {layout.nodes.map((n) => {
          const fill = n.kind === "fund" ? n.color ?? NEUTRAL : n.kind === "untraced" ? UNTRACED : NEUTRAL;
          const cy = n.y + n.h / 2;
          const left = n.column === 0;
          const tx = left ? n.x - 8 : n.x + NODE_W + 8;
          const anchor = left ? "end" : "start";
          const clickable = n.kind === "fund" && n.slug && onFundClick;
          const amount = usd(n.value, true);
          const big = n.h >= 26;
          const max = n.column === 1 ? 26 : 30;
          return (
            <g
              key={n.id}
              onPointerMove={(e) => point(e, "node", n.id)}
              onClick={clickable ? () => onFundClick!(n.slug!) : undefined}
              onKeyDown={clickable ? (e) => (e.key === "Enter" || e.key === " ") && onFundClick!(n.slug!) : undefined}
              tabIndex={clickable ? 0 : undefined}
              role={clickable ? "link" : undefined}
              aria-label={clickable ? `Open ${n.label}` : undefined}
              className={clickable ? "cursor-pointer outline-none" : undefined}
            >
              <rect x={n.x} y={n.y} width={NODE_W} height={n.h} rx={3} fill={fill} />
              {/* Halo keeps mid-column labels legible over the bands. */}
              <text x={tx} y={big ? cy - 3 : cy + 4} textAnchor={anchor} fontSize={12.5} fontWeight={n.kind === "fund" ? 600 : 500} fill="var(--ink)" stroke={n.column === 1 ? "var(--surface)" : undefined} strokeWidth={n.column === 1 ? 4 : undefined} paintOrder="stroke" className={clickable ? "underline-offset-2 hover:underline" : undefined}>
                {clip(n.label, max)}
                {!big && <tspan fill="var(--muted)" fontWeight={400}> · {amount}</tspan>}
              </text>
              {big && (
                <text x={tx} y={cy + 12} textAnchor={anchor} fontSize={11} fill="var(--muted)" stroke={n.column === 1 ? "var(--surface)" : undefined} strokeWidth={n.column === 1 ? 4 : undefined} paintOrder="stroke" className="tnum">
                  {amount}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {(hl || hn) && hover && (
        <div className="pointer-events-none absolute z-10 card shadow-lg px-3 py-2 text-xs max-w-[280px]" style={{ left: Math.min(hover.x + 14, width - 290), top: Math.min(hover.y + 14, layout.height - 70) }}>
          {hl && (
            <>
              <div className="text-ink-2">{layout.byId.get(hl.source)!.label} <span className="text-muted">→</span> {layout.byId.get(hl.target)!.label}</div>
              <div className="font-semibold tnum text-sm mt-0.5">{usd(hl.value)}</div>
            </>
          )}
          {hn && (
            <>
              <div className="font-semibold text-ink">{hn.label}</div>
              {hn.inV > 0 && <div className="text-ink-2 tnum mt-0.5">In: <b className="text-ink">{usd(hn.inV)}</b></div>}
              {hn.outV > 0 && <div className="text-ink-2 tnum">Out: <b className="text-ink">{usd(hn.outV)}</b></div>}
              {hn.kind === "fund" && onFundClick && <div className="text-muted mt-1">Click to open this fund&apos;s trail</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
