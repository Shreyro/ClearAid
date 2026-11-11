"use client";

import { MapPin } from "lucide-react";
import { DonateForm, type GiveInfo } from "@/components/DonateForm";
import { useJson } from "@/components/hooks";

/** A fund's public donation link: who is asking, for what, and the donate form. */
export function GivePage({ slug }: { slug: string }) {
  const { data, error } = useJson<GiveInfo>(`/api/give/${slug}`);

  if (error) return <Shell><div className="card p-8 text-center text-ink-2">{error}</div></Shell>;
  if (!data) return <Shell><div className="card h-96 animate-pulse" /></Shell>;
  const { fund, ngo } = data;

  return (
    <Shell>
      <div className="card overflow-hidden">
        <div className="h-1.5" style={{ background: fund.accent }} />
        <div className="p-6 sm:p-8">
          <div className="text-sm text-ink-2">{ngo.name}{ngo.country ? ` · ${ngo.country}` : ""}</div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight mt-1">{fund.title}</h1>
          <div className="flex flex-wrap items-center gap-3 mt-2 text-sm text-ink-2">
            <span className="inline-flex items-center gap-1"><MapPin className="h-4 w-4" /> {fund.region}</span>
            {fund.code && <span className="font-mono text-xs rounded border border-line px-1.5 py-0.5">#{fund.code}</span>}
          </div>
          {fund.description && <p className="mt-4 text-sm text-ink-2 leading-relaxed">{fund.description}</p>}
          <div className="mt-6">
            <DonateForm slug={slug} info={data} />
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-xl">
        {children}
        <p className="text-center text-xs text-muted mt-6">Tracked with ClearAid: every gift is recorded on the fund&apos;s hash-chained ledger.</p>
      </div>
    </main>
  );
}
