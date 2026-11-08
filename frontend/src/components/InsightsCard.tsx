"use client";

import { useState } from "react";
import { AlertTriangle, Lightbulb, RefreshCw, Sparkles, Target } from "lucide-react";
import { api, ago, useJson } from "./hooks";
import { Pill } from "./ui";

type Insights = { engine: string; generatedAt: string; headline: string; summary: string; highlights: string[]; gaps: string[]; risks: string[]; runwayDays: number | null; donorMessage: string };

export function InsightsCard({ fundId }: { fundId: string }) {
  const { data, setData, error } = useJson<Insights>(`/api/funds/${fundId}/insights`);
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setBusy(true);
    try {
      setData(await api<Insights>(`/api/funds/${fundId}/insights`, { method: "POST" }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card p-5 bg-gradient-to-br from-[#f2faf8] to-surface">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-semibold flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand" /> Crisis insights
        </h2>
        <div className="flex items-center gap-2">
          {data && <Pill tone={data.engine === "claude" ? "brand" : "neutral"}>{data.engine === "claude" ? "Written by Claude from the ledger" : "Computed summary"}</Pill>}
          <button className="btn btn-ghost !p-1.5" onClick={refresh} disabled={busy} title="Regenerate">
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>
      {!data && !error && <div className="mt-4 space-y-2"><div className="h-5 w-2/3 bg-[#eceae4] rounded animate-pulse" /><div className="h-4 w-full bg-[#eceae4] rounded animate-pulse" /><div className="h-4 w-5/6 bg-[#eceae4] rounded animate-pulse" /></div>}
      {error && <p className="text-sm text-critical mt-3">{error}</p>}
      {data && (
        <div className={busy ? "opacity-60" : ""}>
          <p className="text-lg font-semibold mt-3 leading-snug">{data.headline}</p>
          <p className="text-sm text-ink-2 mt-1.5">{data.summary}</p>
          <div className="grid sm:grid-cols-2 gap-4 mt-4 text-sm">
            <div>
              <div className="text-xs font-semibold text-muted flex items-center gap-1 mb-1.5"><Lightbulb className="h-3.5 w-3.5" /> What your money did</div>
              <ul className="space-y-1.5 list-disc pl-4 marker:text-brand">{data.highlights.map((h) => <li key={h}>{h}</li>)}</ul>
            </div>
            <div>
              <div className="text-xs font-semibold text-muted flex items-center gap-1 mb-1.5"><Target className="h-3.5 w-3.5" /> Still needed</div>
              <ul className="space-y-1.5 list-disc pl-4 marker:text-serious">{data.gaps.map((h) => <li key={h}>{h}</li>)}</ul>
            </div>
          </div>
          {data.risks.length > 0 && (
            <div className="mt-4 rounded-lg bg-[#fff8e6] px-3 py-2 text-sm">
              <div className="text-xs font-semibold text-[#7a5200] flex items-center gap-1 mb-1"><AlertTriangle className="h-3.5 w-3.5" /> Integrity notes</div>
              <ul className="list-disc pl-4 space-y-0.5">{data.risks.map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>{data.runwayDays != null ? `Balance lasts about ${data.runwayDays} days at the current pace` : "No spending in the last 7 days"}</span>
            <span>Updated {ago(data.generatedAt)}</span>
          </div>
          <p className="mt-3 text-sm italic text-ink-2 border-l-2 border-brand pl-3">{data.donorMessage}</p>
        </div>
      )}
    </section>
  );
}
