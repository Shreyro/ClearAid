"use client";

import Link from "next/link";
import { ArrowRight, Bot, Camera, EyeOff, FileCheck2, Link2, RotateCcw, ShieldCheck, Wallet } from "lucide-react";
import { useJson, useLive, usd } from "@/components/hooks";
import { Meter, Pill, StatusPill } from "@/components/ui";

type Card = {
  id: string;
  slug: string;
  title: string;
  region: string;
  status: string;
  accent: string;
  goal: number;
  raised: number;
  spent: number;
  balance: number;
  donors: number;
  transparency: number;
  beneficiaries: number;
  ngo: { name: string; verified: boolean };
};
type Resp = { funds: Card[]; totals: { raised: number; spent: number; donors: number; beneficiaries: number; verifiedPayments: number; rejected: number } };

const STEPS = [
  { icon: Wallet, title: "Give through PayPal", body: "Donations land in a dedicated relief fund, never a general account. Each gift is a PayPal capture we can trace and refund." },
  { icon: Camera, title: "Vendors prove delivery", body: "To get paid, a verified vendor uploads the receipt and photos of the goods at the relief site." },
  { icon: Bot, title: "AI audits every request", body: "Claude reads the receipt, checks the photos and prices, redacts personal data. Rule checks catch reused photos and budget breaches." },
  { icon: FileCheck2, title: "Humans approve, PayPal pays", body: "NGO staff sign off (two signatures for large amounts) and PayPal Payouts sends the money straight to the vendor." },
  { icon: Link2, title: "Published on a hash-chained ledger", body: "Every dollar in and out is a public, tamper-evident entry anyone can verify in their browser." },
  { icon: RotateCcw, title: "Leftovers go where you choose", body: "When the crisis ends, your unspent share is refunded to your PayPal or carried forward to another fund. Your choice." },
];

export default function Home() {
  const { data, reload } = useJson<Resp>("/api/funds");
  const live = useLive(undefined, () => void reload());
  const t = data?.totals;

  return (
    <div>
      <section className="mx-auto max-w-6xl px-4 pt-12 pb-10">
        <div className="max-w-3xl">
          <Pill tone="brand" className="mb-4">
            <span className={`h-1.5 w-1.5 rounded-full bg-brand ${live ? "live-dot" : ""}`} /> Live public ledger
          </Pill>
          <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.05]">Every relief dollar, accounted for.</h1>
          <p className="mt-4 text-lg text-ink-2 max-w-2xl">
            ClearAid gives NGOs dedicated disaster-relief funds on PayPal. Donors see who withdrew money, how much and for what, backed by receipts, delivery photos and an AI audit. Personal data is redacted, and leftovers come back to donors.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/funds/cyclone-asha" className="btn btn-primary">
              See a live fund <ArrowRight className="h-4 w-4" />
            </Link>
            <a href="#how" className="btn btn-ghost">
              How it works
            </a>
          </div>
        </div>

        <div className="mt-10 grid grid-cols-2 lg:grid-cols-4 gap-3">
          <BigStat label="Donated through PayPal" value={t ? usd(t.raised, true) : "—"} sub={t ? `${t.donors.toLocaleString()} gifts across funds` : ""} />
          <BigStat label="Paid to verified vendors" value={t ? usd(t.spent, true) : "—"} sub={t ? `${t.verifiedPayments} receipted, photo-verified payouts` : ""} />
          <BigStat label="People reached" value={t ? t.beneficiaries.toLocaleString() : "—"} sub="as reported in vendor delivery logs" />
          <BigStat label="Requests stopped by audit" value={t ? String(t.rejected) : "—"} sub="reused photos, inflated prices, missing proof" />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4">
        <h2 className="text-lg font-semibold mb-3">Relief funds</h2>
        <div className="grid md:grid-cols-3 gap-4">
          {data?.funds.map((f) => (
            <Link key={f.id} href={`/funds/${f.slug}`} className="card overflow-hidden hover:border-line-strong transition-colors group">
              <div className="h-1.5" style={{ background: f.accent }} />
              <div className="p-5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted truncate">{f.ngo.name}</span>
                  <StatusPill status={f.status} />
                </div>
                <h3 className="mt-2 font-semibold leading-snug group-hover:underline">{f.title}</h3>
                <p className="text-sm text-ink-2 mt-1 truncate">{f.region}</p>
                <div className="mt-4">
                  <div className="flex justify-between text-sm mb-1.5">
                    <span className="font-semibold">{usd(f.raised)}</span>
                    <span className="text-muted">of {usd(f.goal, true)}</span>
                  </div>
                  <Meter value={f.raised} max={f.goal} color={f.accent} />
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                  <Mini label="Deployed" value={usd(f.spent, true)} />
                  <Mini label="Balance" value={usd(f.balance, true)} />
                  <Mini label="Transparency" value={`${f.transparency}/100`} />
                </div>
              </div>
            </Link>
          ))}
          {!data && [0, 1, 2].map((i) => <div key={i} className="card h-64 animate-pulse" />)}
        </div>
      </section>

      <section id="how" className="mx-auto max-w-6xl px-4 mt-16">
        <h2 className="text-2xl font-semibold tracking-tight">How ClearAid keeps relief honest</h2>
        <p className="text-ink-2 mt-1">Money can only leave a fund as a documented, audited, approved payment to a verified vendor.</p>
        <ol className="mt-6 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="card p-5">
              <div className="flex items-center gap-2">
                <span className="h-8 w-8 rounded-lg bg-brand-wash text-brand-ink grid place-items-center">
                  <s.icon className="h-4 w-4" />
                </span>
                <span className="text-xs font-semibold text-muted">Step {i + 1}</span>
              </div>
              <h3 className="font-semibold mt-3">{s.title}</h3>
              <p className="text-sm text-ink-2 mt-1">{s.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-6 grid md:grid-cols-2 gap-4">
          <div className="card p-5">
            <div className="flex items-center gap-2 font-semibold">
              <ShieldCheck className="h-4 w-4 text-brand" /> Built on PayPal
            </div>
            <ul className="mt-2 text-sm text-ink-2 space-y-1">
              <li>JavaScript SDK v6 + Orders v2 for donations (item category DONATION)</li>
              <li>Payouts API releases approved withdrawals to vendors</li>
              <li>Partial capture refunds return each donor&apos;s unspent share</li>
              <li>Webhooks record refunds, disputes and bounced payouts on the public ledger</li>
              <li>PayPal Agent Toolkit lets the NGO Copilot reconcile and refund, with human sign-off</li>
            </ul>
          </div>
          <div className="card p-5">
            <div className="flex items-center gap-2 font-semibold">
              <EyeOff className="h-4 w-4 text-brand" /> Privacy and dignity by default
            </div>
            <ul className="mt-2 text-sm text-ink-2 space-y-1">
              <li>Names, phone numbers and ID numbers are redacted before anything is published</li>
              <li>Photos showing identifiable people stay private; donors see the audit finding instead</li>
              <li>Donors appear anonymously unless they choose to show their name</li>
              <li>Receipts with personal data are summarised as line items, not shown</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}

function BigStat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="text-2xl sm:text-3xl font-semibold tracking-tight mt-1">{value}</div>
      <div className="text-xs text-ink-2 mt-1">{sub}</div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[#f7f7f3] px-2 py-1.5">
      <div className="text-muted">{label}</div>
      <div className="font-semibold text-ink">{value}</div>
    </div>
  );
}
