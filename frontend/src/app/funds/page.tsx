"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Page, useMe } from "@/components/AppShell";
import { useJson, useLive, usd } from "@/components/hooks";
import { Empty, Meter, StatusPill } from "@/components/ui";
import { CodeChip } from "@/components/banking";

type FundRow = { id: string; slug: string; title: string; status: string; accent: string; codes: string[]; received: number; spent: number; returned: number; balance: number; chainValid: boolean };

export default function FundsPage() {
  const { me } = useMe();
  const { data, reload } = useJson<{ funds: FundRow[] }>("/api/overview");
  useLive(undefined, (e) => {
    if (e.kind === "ledger" || e.kind === "bank" || e.kind === "fund") void reload();
  });

  return (
    <Page
      title="Funds"
      subtitle={`Each relief fund's trail: what came in, what went out and what's left. ${me.role === "admin" ? "Create funds and set tracking codes in Settings." : "Ask for access to other funds in Settings."}`}
      actions={<Link href={me.role === "admin" ? "/settings?tab=funds" : "/settings?tab=access"} className="btn btn-ghost">{me.role === "admin" ? "Manage funds" : "Fund access"}</Link>}
    >
      {!data ? (
        <div className="grid md:grid-cols-2 gap-4">{[0, 1].map((i) => <div key={i} className="card h-48 animate-pulse" />)}</div>
      ) : data.funds.length === 0 ? (
        <div className="card"><Empty>You don&apos;t have access to any funds yet. <Link href="/settings?tab=access" className="underline">Ask to join one</Link>.</Empty></div>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {data.funds.map((f) => {
            const out = f.spent + f.returned;
            return (
              <Link key={f.id} href={`/funds/${f.slug}`} className="card p-5 flex flex-col gap-4 hover:border-brand group">
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-semibold leading-snug flex items-start gap-2"><span className="h-2.5 w-2.5 rounded-full shrink-0 mt-1.5" style={{ background: f.accent }} />{f.title}</h2>
                    {f.status !== "active" && <StatusPill status={f.status} />}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">{f.codes.length ? f.codes.map((c) => <CodeChip key={c} code={c} />) : <span className="text-xs text-muted">No tracking code</span>}</div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div><div className="text-xs text-muted">In</div><div className="font-semibold tnum">{usd(f.received, true)}</div></div>
                  <div><div className="text-xs text-muted">Out</div><div className="font-semibold tnum">{usd(out, true)}</div></div>
                  <div><div className="text-xs text-muted">Held</div><div className="font-semibold tnum">{usd(f.balance, true)}</div></div>
                </div>
                <div>
                  <Meter value={out} max={Math.max(f.received, 1)} color={f.accent} />
                  <div className="text-xs text-muted mt-1.5 flex justify-between">
                    <span>{f.received ? `${Math.round((out / f.received) * 100)}% of money in has gone out` : "Nothing received yet"}</span>
                    <span className="inline-flex items-center gap-1 text-ink-2 group-hover:text-ink">Trail <ArrowRight className="h-3 w-3" /></span>
                  </div>
                </div>
                {!f.chainValid && <div className="text-xs text-critical">Ledger hash chain is broken</div>}
              </Link>
            );
          })}
        </div>
      )}
    </Page>
  );
}
