"use client";

import clsx from "clsx";
import { AlertTriangle, CheckCircle2, CircleHelp, ShieldCheck, XCircle } from "lucide-react";
import type { ReactNode } from "react";

export function Pill({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "brand" | "info"; className?: string }) {
  const tones = {
    neutral: "bg-[#f1f0ec] text-ink-2",
    good: "bg-[#e7f6e7] text-good-ink",
    warn: "bg-[#fff4d6] text-[#7a5200]",
    bad: "bg-[#fbe9e9] text-[#9b2424]",
    brand: "bg-brand-wash text-brand-ink",
    info: "bg-[#e8f1fc] text-[#1c4f8f]",
  } as const;
  return <span className={clsx("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap", tones[tone], className)}>{children}</span>;
}

export function StatusIcon({ status, className = "h-4 w-4" }: { status: "pass" | "warn" | "fail" | string; className?: string }) {
  if (status === "pass") return <CheckCircle2 className={clsx(className, "text-good shrink-0")} aria-label="Pass" />;
  if (status === "warn") return <AlertTriangle className={clsx(className, "text-[#c98a00] shrink-0")} aria-label="Warning" />;
  if (status === "fail") return <XCircle className={clsx(className, "text-critical shrink-0")} aria-label="Fail" />;
  return <CircleHelp className={clsx(className, "text-muted shrink-0")} />;
}

export function RiskBadge({ score, verdict }: { score?: number | null; verdict?: string }) {
  if (score == null) return <Pill>Not audited</Pill>;
  const tone = score <= 30 ? "good" : score <= 60 ? "warn" : "bad";
  const label = score <= 30 ? "Low risk" : score <= 60 ? "Medium risk" : "High risk";
  return (
    <Pill tone={tone}>
      <ShieldCheck className="h-3.5 w-3.5" />
      {label} · {Math.round(score)}
      {verdict === "reject" && score <= 60 ? " · reject" : ""}
    </Pill>
  );
}

const STATUS: Record<string, { label: string; tone: "neutral" | "good" | "warn" | "bad" | "brand" | "info" }> = {
  auditing: { label: "AI auditing…", tone: "info" },
  pending_approval: { label: "Awaiting approval", tone: "warn" },
  paid: { label: "Paid via PayPal", tone: "good" },
  rejected: { label: "Rejected", tone: "bad" },
  payout_failed: { label: "Payout failed", tone: "bad" },
  active: { label: "Active", tone: "good" },
  closing: { label: "Closing · donors choosing", tone: "warn" },
  closed: { label: "Closed", tone: "neutral" },
};

export function StatusPill({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="text-xl sm:text-2xl font-semibold tracking-tight mt-0.5">{value}</div>
      {sub ? <div className="text-xs text-ink-2 mt-0.5">{sub}</div> : null}
    </div>
  );
}

export function Section({ title, action, children, className, id }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={clsx("card p-5 min-w-0", className)}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Meter({ value, max, color = "var(--brand)" }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-2 rounded-full bg-[#ecebe6] overflow-hidden" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-sm text-muted py-6 text-center">{children}</div>;
}
