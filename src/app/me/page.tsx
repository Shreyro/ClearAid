"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, HandHeart, Loader2, RotateCcw, Shuffle } from "lucide-react";
import clsx from "clsx";
import { api, shortDate, useJson, usd } from "@/components/hooks";
import { Pill, RiskBadge, StatusPill } from "@/components/ui";
import { CAT_LABEL } from "@/components/SpendCard";

type Item = {
  donationId: string;
  fund: { id: string; slug: string; title: string; status: string; accent: string };
  amount: number;
  source: string;
  fromFund?: string;
  createdAt: string;
  attributed: number;
  refunded: number;
  carriedOut: number;
  leftover: number;
  election?: { choice: "refund" | "carry_forward"; targetFundId?: string; at: string };
  spends: { withdrawalId: string; category: string; vendor: string; purpose: string; share: number; paidAt?: string; units: number | null; unit: string | null; item: string | null; riskScore: number | null }[];
};
type Resp = {
  impact: { donor: { id: string; name: string; email: string; publicLabel: string }; totals: { given: number; deployed: number; refunded: number; unspent: number }; items: Item[] };
  activeFunds: { id: string; title: string; slug: string }[];
};
type Sess = { session: { role: string }; personas: { donors: { id: string; name: string; sub: string }[] } };

export default function MyImpact() {
  const { data: sess, reload: reloadSess } = useJson<Sess>("/api/session");
  const isDonor = sess?.session.role === "donor";
  const { data, reload, error } = useJson<Resp>(isDonor ? "/api/me" : null);
  useEffect(() => {
    const h = () => {
      void reloadSess();
      void reload();
    };
    window.addEventListener("clearaid:persona", h);
    return () => window.removeEventListener("clearaid:persona", h);
  }, [reload, reloadSess]);

  if (!sess) return <div className="mx-auto max-w-4xl px-4 py-10"><div className="card h-40 animate-pulse" /></div>;
  if (!isDonor) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <HandHeart className="h-10 w-10 text-brand mx-auto" />
        <h1 className="text-2xl font-semibold mt-3">Follow your dollar</h1>
        <p className="text-ink-2 mt-2">Donate to any fund and you&apos;ll land here automatically. For the demo, pick a donor persona:</p>
        <div className="grid sm:grid-cols-2 gap-2 mt-6 text-left">
          {sess.personas.donors.map((d) => (
            <button
              key={d.id}
              className="card p-4 hover:border-brand"
              onClick={async () => {
                await api("/api/session", { json: { role: "donor", id: d.id } });
                window.dispatchEvent(new Event("clearaid:persona"));
                await reloadSess();
              }}
            >
              <div className="font-semibold">{d.name}</div>
              <div className="text-xs text-muted">{d.sub}</div>
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (error) return <div className="mx-auto max-w-4xl px-4 py-16 text-center text-ink-2">{error}</div>;
  if (!data?.impact) return <div className="mx-auto max-w-4xl px-4 py-10"><div className="card h-40 animate-pulse" /></div>;
  const { impact } = data;
  const t = impact.totals;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="text-sm text-muted">Signed in as {impact.donor.name} · shown publicly as “{impact.donor.publicLabel}”</div>
      <h1 className="text-3xl font-semibold tracking-tight mt-1">Where your {usd(t.given)} went</h1>
      <p className="text-ink-2 mt-1 max-w-2xl">
        Every vendor payout is charged pro-rata to the donors whose money was in the fund at that moment, so you can see your exact share of each delivery.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
        <Tile label="You gave" value={usd(t.given)} />
        <Tile label="Delivered as aid" value={usd(t.deployed)} accent />
        <Tile label="Refunded to you" value={usd(t.refunded)} />
        <Tile label="Still in funds" value={usd(t.unspent)} />
      </div>

      <div className="space-y-5 mt-8">
        {impact.items.map((it) => (
          <DonationCard key={it.donationId} it={it} activeFunds={data.activeFunds} onSaved={reload} />
        ))}
        {!impact.items.length && (
          <div className="card p-8 text-center text-ink-2">
            No donations yet. <Link className="text-brand underline" href="/funds/cyclone-asha">Give to a fund</Link>
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={clsx("card p-4", accent && "bg-brand-wash border-[#bfe3dc]")}>
      <div className="text-xs text-muted font-medium">{label}</div>
      <div className="text-2xl font-semibold tracking-tight tnum mt-0.5">{value}</div>
    </div>
  );
}

function DonationCard({ it, activeFunds, onSaved }: { it: Item; activeFunds: Resp["activeFunds"]; onSaved: () => void }) {
  const pct = (v: number) => `${(v / Math.max(it.amount, 1)) * 100}%`;
  const units = it.spends.filter((s) => s.units && s.units >= 0.1);
  return (
    <section className="card overflow-hidden">
      <div className="h-1" style={{ background: it.fund.accent }} />
      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link href={`/funds/${it.fund.slug}`} className="font-semibold hover:underline">{it.fund.title}</Link>
            <div className="text-xs text-muted mt-0.5">
              {it.source === "carry_forward" ? `Carried forward from ${it.fromFund}` : `Donated ${shortDate(it.createdAt)} via PayPal`}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xl font-semibold tnum">{usd(it.amount)}</div>
            <StatusPill status={it.fund.status} />
          </div>
        </div>

        <div className="flex h-3 rounded-full overflow-hidden mt-4 gap-0.5 bg-[#f1f0ec]">
          <div style={{ width: pct(it.attributed), background: "var(--series-1)" }} />
          {it.refunded > 0 && <div style={{ width: pct(it.refunded), background: "var(--series-2)" }} />}
          {it.carriedOut > 0 && <div style={{ width: pct(it.carriedOut), background: "#6250d6" }} />}
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-ink-2 mt-2">
          <Key color="var(--series-1)" label={`Delivered ${usd(it.attributed)}`} />
          {it.refunded > 0 && <Key color="var(--series-2)" label={`Refunded ${usd(it.refunded)}`} />}
          {it.carriedOut > 0 && <Key color="#6250d6" label={`Carried forward ${usd(it.carriedOut)}`} />}
          <Key color="#e1e0d9" label={`Unspent ${usd(it.leftover)}`} />
        </div>

        {units.length > 0 && (
          <p className="mt-4 text-sm">
            <span className="font-semibold">Your gift helped deliver </span>
            {units.slice(0, 4).map((s, i) => (
              <span key={s.withdrawalId}>
                {i > 0 && (i === Math.min(units.length, 4) - 1 ? " and " : ", ")}~{s.units} {s.unit}
                {s.item ? ` (${s.item.split("(")[0].trim().toLowerCase()})` : ""}
              </span>
            ))}
            .
          </p>
        )}

        {it.fund.status === "closing" && it.leftover > 0 && <Election it={it} activeFunds={activeFunds} onSaved={onSaved} />}

        {it.spends.length > 0 && (
          <details className="mt-4 group" open={it.spends.length <= 4}>
            <summary className="text-sm font-semibold cursor-pointer text-ink-2">Your share of {it.spends.length} vendor payment{it.spends.length > 1 ? "s" : ""}</summary>
            <ul className="mt-3 divide-y divide-line">
              {it.spends.map((s) => (
                <li key={s.withdrawalId}>
                  <Link href={`/spend/${s.withdrawalId}`} className="flex items-center gap-3 py-2.5 hover:bg-[#fafaf7] -mx-2 px-2 rounded-lg">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{s.vendor} <span className="text-muted font-normal">· {CAT_LABEL[s.category]}</span></div>
                      <div className="text-xs text-ink-2 truncate">{s.purpose}</div>
                    </div>
                    <RiskBadge score={s.riskScore} />
                    <div className="text-right shrink-0 w-24">
                      <div className="font-semibold tnum text-sm">{usd(s.share)}</div>
                      {s.units ? <div className="text-[11px] text-muted">≈ {s.units} {s.unit}</div> : null}
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}

function Key({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} /> {label}
    </span>
  );
}

function Election({ it, activeFunds, onSaved }: { it: Item; activeFunds: Resp["activeFunds"]; onSaved: () => void }) {
  const targets = activeFunds.filter((f) => f.id !== it.fund.id);
  const [choice, setChoice] = useState<"refund" | "carry_forward">(it.election?.choice ?? "refund");
  const [target, setTarget] = useState(it.election?.targetFundId ?? targets[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/me/election", { json: { fundId: it.fund.id, choice, targetFundId: choice === "carry_forward" ? target : undefined } });
      setMsg("Saved. It will be applied when the NGO finalises the fund.");
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 rounded-xl border border-[#f3d48a] bg-[#fffaf0] p-4">
      <div className="font-semibold text-sm">This fund is closing. {usd(it.leftover)} of your gift was not needed.</div>
      <div className="grid sm:grid-cols-2 gap-2 mt-3">
        <label className={clsx("card p-3 cursor-pointer flex gap-2", choice === "refund" && "border-brand ring-2 ring-brand-wash")}>
          <input type="radio" checked={choice === "refund"} onChange={() => setChoice("refund")} />
          <div>
            <div className="font-medium text-sm flex items-center gap-1"><RotateCcw className="h-3.5 w-3.5" /> Refund {usd(it.leftover)}</div>
            <div className="text-xs text-ink-2">Partial refund to your PayPal account from the original payment.</div>
          </div>
        </label>
        <label className={clsx("card p-3 cursor-pointer flex gap-2", choice === "carry_forward" && "border-brand ring-2 ring-brand-wash")}>
          <input type="radio" checked={choice === "carry_forward"} onChange={() => setChoice("carry_forward")} />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm flex items-center gap-1"><Shuffle className="h-3.5 w-3.5" /> Carry it forward</div>
            <select className="input mt-1 !py-1 text-xs" value={target} onChange={(e) => { setTarget(e.target.value); setChoice("carry_forward"); }}>
              {targets.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
            </select>
          </div>
        </label>
      </div>
      <div className="flex items-center gap-3 mt-3">
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Save my choice</button>
        {it.election && <Pill tone="brand">Current: {it.election.choice === "refund" ? "refund" : "carry forward"}</Pill>}
        {msg && <span className="text-xs text-ink-2">{msg}</span>}
      </div>
    </div>
  );
}
