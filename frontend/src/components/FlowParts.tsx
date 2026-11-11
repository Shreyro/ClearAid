"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import clsx from "clsx";
import { ago, usd } from "./hooks";
import { Section } from "./ui";

export type Party = { name: string; total: number; count: number; funds: string[]; via: string };
export type Movement = { id: string; ts: string; from: string; to: string; amount: number; via?: string; fundTitle: string; typeLabel: string };

export function PartyTable({ title, parties, sign, more }: { title: string; parties: Party[]; sign: "+" | "−"; more?: { href: string; label: string } }) {
  const max = Math.max(...parties.map((p) => p.total), 1);
  return (
    <Section title={title} action={more && <Link href={more.href} className="text-xs text-ink-2 hover:text-ink">{more.label} →</Link>}>
      {parties.length === 0 ? (
        <p className="text-sm text-muted">Nothing yet.</p>
      ) : (
        <ul className="space-y-3">
          {parties.map((p) => (
            <li key={p.name}>
              <div className="flex justify-between gap-3 text-sm">
                <span className="truncate font-medium" title={p.name}>{p.name}</span>
                <span className="tnum font-semibold shrink-0">{sign}{usd(p.total)}</span>
              </div>
              <div className="h-1.5 mt-1 rounded-r bg-hover"><div className="h-full rounded-r" style={{ width: `${(p.total / max) * 100}%`, background: "var(--series-1)" }} /></div>
              <div className="text-xs text-muted mt-1 truncate">{p.count} payment{p.count > 1 ? "s" : ""} · {p.via} · {p.funds.join(", ")}</div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function MovementList({ rows }: { rows: Movement[] }) {
  if (!rows.length) return <p className="text-sm text-muted">No money has moved yet.</p>;
  return (
    <ul className="space-y-3">
      {rows.map((m) => (
        <li key={m.id} className="text-xs">
          <div className="flex justify-between gap-2">
            <span className="text-sm text-ink min-w-0 flex items-center gap-1.5">
              <span className="truncate" title={m.from}>{m.from}</span>
              <ArrowRight className="h-3 w-3 text-muted shrink-0" />
              <span className="truncate" title={m.to}>{m.to}</span>
            </span>
            <span className={clsx("tnum font-semibold shrink-0", m.amount < 0 ? "text-out-ink" : "text-good-ink")}>{m.amount < 0 ? "−" : "+"}{usd(Math.abs(m.amount))}</span>
          </div>
          <div className="text-muted mt-0.5">{ago(m.ts)} · {m.typeLabel}{m.via ? ` · ${m.via}` : ""}</div>
        </li>
      ))}
    </ul>
  );
}
