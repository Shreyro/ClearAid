"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Landmark, Loader2, MapPin } from "lucide-react";
import clsx from "clsx";
import { api, useJson, usd } from "@/components/hooks";

type Info = {
  fund: { slug: string; title: string; region: string; description: string; accent: string; open: boolean; code?: string };
  ngo: { name: string; country: string };
  paypal: { live: boolean; env: string; clientId: string | null };
  limits: { min: number; max: number };
};

type PayPalButtons = { render: (el: HTMLElement) => Promise<void>; close?: () => Promise<void> };
type PayPalSdk = {
  Buttons: (o: {
    style?: Record<string, string>;
    createOrder: () => Promise<string>;
    onApprove: (d: { orderID: string }) => Promise<void>;
    onError?: (e: unknown) => void;
    onCancel?: () => void;
  }) => PayPalButtons;
};

const PRESETS = [10, 25, 50, 100];

/** Load PayPal's JS SDK once for this client ID. */
function usePayPalSdk(clientId: string | null) {
  const [sdk, setSdk] = useState<PayPalSdk | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!clientId) return;
    const w = window as unknown as { paypal?: PayPalSdk };
    const src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons`;
    let s = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    const done = () => (w.paypal ? setSdk(w.paypal) : setError("PayPal didn't load"));
    if (s && w.paypal) {
      done();
      return;
    }
    if (!s) {
      s = document.createElement("script");
      s.src = src;
      s.async = true;
      document.head.appendChild(s);
    }
    const fail = () => setError("Couldn't reach PayPal. Check your connection and reload.");
    s.addEventListener("load", done);
    s.addEventListener("error", fail);
    return () => {
      s?.removeEventListener("load", done);
      s?.removeEventListener("error", fail);
    };
  }, [clientId]);
  return { sdk, error };
}

export function GivePage({ slug }: { slug: string }) {
  const { data, error } = useJson<Info>(`/api/give/${slug}`);
  const [amount, setAmount] = useState("25");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [showName, setShowName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [thanks, setThanks] = useState<string | null>(null);
  const { sdk, error: sdkError } = usePayPalSdk(data?.paypal.live ? data.paypal.clientId : null);
  const box = useRef<HTMLDivElement>(null);
  const form = useRef({ amount, name, email, showName });
  useEffect(() => {
    form.current = { amount, name, email, showName };
  }, [amount, name, email, showName]);

  const cents = Math.round(Number(amount || 0) * 100);
  const valid = data ? cents >= data.limits.min && cents <= data.limits.max : false;

  async function createOrder() {
    setErr(null);
    const f = form.current;
    const r = await api<{ id: string }>(`/api/give/${slug}/order`, { json: { amountUsd: Number(f.amount), name: f.name, email: f.email, showName: f.showName } });
    return r.id;
  }
  async function capture(orderId: string) {
    const r = await api<{ message: string }>(`/api/give/${slug}/capture`, { json: { orderId } });
    setThanks(r.message);
  }

  // Render PayPal's buttons when live. They read the form through a ref, so they don't need re-rendering on each keystroke.
  useEffect(() => {
    if (!sdk || !box.current || thanks) return;
    const el = box.current;
    el.innerHTML = "";
    const b = sdk.Buttons({
      style: { layout: "vertical", shape: "rect", label: "donate" },
      createOrder: async () => {
        try {
          return await createOrder();
        } catch (e) {
          setErr((e as Error).message);
          throw e;
        }
      },
      onApprove: async (d) => {
        try {
          await capture(d.orderID);
        } catch (e) {
          setErr((e as Error).message);
        }
      },
      onError: () => setErr("PayPal couldn't complete the payment. Nothing was charged."),
    });
    void b.render(el);
    return () => void b.close?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdk, thanks]);

  async function simulate() {
    setBusy(true);
    setErr(null);
    try {
      await capture(await createOrder());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

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

          {thanks ? (
            <div className="mt-6 rounded-xl bg-brand-wash p-5 flex items-start gap-3" role="status">
              <CheckCircle2 className="h-6 w-6 text-brand shrink-0" />
              <div>
                <div className="font-semibold">{thanks}</div>
                <p className="text-sm text-ink-2 mt-1">It&apos;s recorded against {fund.code ? `tracking code #${fund.code}` : "this fund"} on a tamper-evident ledger, so the NGO can show where it goes.</p>
                <button className="btn btn-ghost mt-3" onClick={() => setThanks(null)}>Give again</button>
              </div>
            </div>
          ) : !fund.open ? (
            <p className="mt-6 card p-4 text-sm text-ink-2">This fund isn&apos;t taking donations any more.</p>
          ) : (
            <div className="mt-6 grid gap-4">
              <fieldset>
                <legend className="label">Amount (USD)</legend>
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((p) => (
                    <button key={p} type="button" onClick={() => setAmount(String(p))} aria-pressed={amount === String(p)} className={clsx("rounded-lg border px-4 py-2 text-sm font-semibold tnum", amount === String(p) ? "border-brand bg-brand-wash text-brand-ink" : "border-line bg-surface")}>
                      ${p}
                    </button>
                  ))}
                  <input aria-label="Other amount" className="input !w-32 tnum" type="number" min={data.limits.min / 100} max={data.limits.max / 100} step="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </div>
              </fieldset>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="g-name">Name (optional)</label>
                  <input id="g-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
                </div>
                <div>
                  <label className="label" htmlFor="g-email">Email for a receipt (optional)</label>
                  <input id="g-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-ink-2">
                <input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} /> Show my name on the fund&apos;s ledger
              </label>

              {!valid && <p className="text-sm text-critical">Give between {usd(data.limits.min)} and {usd(data.limits.max)}.</p>}
              {data.paypal.live ? (
                <div className={clsx(!valid && "pointer-events-none opacity-50")}>
                  {sdkError ? <p className="text-sm text-critical">{sdkError}</p> : !sdk && <div className="h-12 grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted" /></div>}
                  <div ref={box} />
                  {data.paypal.env !== "live" && <p className="text-xs text-muted mt-1">PayPal sandbox: use a sandbox personal account to pay. No real money moves.</p>}
                </div>
              ) : (
                <div>
                  <button className="btn btn-primary w-full justify-center !py-3" disabled={!valid || busy} onClick={simulate}>
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />} Donate {valid ? usd(cents) : ""} (simulated PayPal)
                  </button>
                  <p className="text-xs text-muted mt-1">PayPal keys aren&apos;t set on this server, so the payment is simulated and marked as such on the ledger.</p>
                </div>
              )}
              {err && <p className="text-sm text-critical" role="alert">{err}</p>}
            </div>
          )}
        </div>
        {fund.code && (
          <div className="border-t border-line bg-sunken px-6 sm:px-8 py-4 text-sm text-ink-2 flex items-start gap-2">
            <Landmark className="h-4 w-4 mt-0.5 shrink-0" />
            <span>Paying by bank transfer instead? Put <span className="font-mono font-semibold text-ink">#{fund.code}</span> in the payment reference so it&apos;s matched to this fund automatically.</span>
          </div>
        )}
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
