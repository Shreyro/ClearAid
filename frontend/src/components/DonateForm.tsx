"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Landmark, Loader2, Undo2 } from "lucide-react";
import clsx from "clsx";
import { api, useJson, usd } from "./hooks";

/** GET /api/give/<slug>: what a donor needs to give to one fund. */
export type GiveInfo = {
  fund: { slug: string; title: string; region: string; description: string; accent: string; open: boolean; code?: string };
  ngo: { name: string; country: string };
  /** merchantId: the fund pays an account connected by login (PayPal's buttons pay that merchant). */
  paypal: { live: boolean; env: string; clientId: string | null; merchantId?: string | null };
  limits: { min: number; max: number };
  /** The NGO lets donors ask for their share of the leftover back when the fund closes. */
  returns?: boolean;
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
function usePayPalSdk(clientId: string | null, merchantId?: string | null) {
  const [sdk, setSdk] = useState<PayPalSdk | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!clientId) return;
    const w = window as unknown as { paypal?: PayPalSdk };
    const src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons${merchantId ? `&merchant-id=${encodeURIComponent(merchantId)}` : ""}`;
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
  }, [clientId, merchantId]);
  return { sdk, error };
}

/**
 * The donate form for one fund: amount, optional name and email, and PayPal's
 * buttons (or a simulated payment when the server has no PayPal keys). The
 * fund's tracking code goes on the PayPal order by itself. Used on the
 * donation link page and inside donate embeds. `preview` shows the form
 * without letting anyone pay (the embed editor).
 */
export function DonateForm({ slug, info: given, preview, compact }: { slug: string; info?: GiveInfo; preview?: boolean; compact?: boolean }) {
  const loaded = useJson<GiveInfo>(given ? null : `/api/give/${slug}`);
  const data = given ?? loaded.data;
  const [amount, setAmount] = useState("25");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [showName, setShowName] = useState(false);
  const [returnOptIn, setReturnOptIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [thanks, setThanks] = useState<string | null>(null);
  const { sdk, error: sdkError } = usePayPalSdk(!preview && data?.paypal.live ? data.paypal.clientId : null, data?.paypal.merchantId);
  const box = useRef<HTMLDivElement>(null);
  const form = useRef({ amount, name, email, showName, returnOptIn });
  useEffect(() => {
    form.current = { amount, name, email, showName, returnOptIn };
  }, [amount, name, email, showName, returnOptIn]);
  const cents = Math.round(Number(amount || 0) * 100);
  const valid = data ? cents >= data.limits.min && cents <= data.limits.max : false;

  async function createOrder() {
    setErr(null);
    const f = form.current;
    const r = await api<{ id: string }>(`/api/give/${slug}/order`, { json: { amountUsd: Number(f.amount), name: f.name, email: f.email, showName: f.showName, returnOptIn: f.returnOptIn } });
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
  }, [sdk, thanks, slug]);

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

  if (loaded.error && !given) return <p className="text-sm text-ink-2">{loaded.error}</p>;
  if (!data) return <div className="h-48 animate-pulse rounded-lg bg-sunken" />;
  const { fund } = data;
  const id = `g-${slug}`;

  if (thanks)
    return (
      <div className="rounded-xl bg-brand-wash p-5 flex items-start gap-3" role="status">
        <CheckCircle2 className="h-6 w-6 text-brand shrink-0" />
        <div>
          <div className="font-semibold">{thanks}</div>
          <p className="text-sm text-ink-2 mt-1">It&apos;s recorded against {fund.code ? `tracking code #${fund.code}` : "this fund"} on a tamper-evident ledger, so the NGO can show where it goes.</p>
          <button className="btn btn-ghost mt-3" onClick={() => setThanks(null)}>Give again</button>
        </div>
      </div>
    );
  if (!fund.open) return <p className="card p-4 text-sm text-ink-2">This fund isn&apos;t taking donations any more.</p>;

  return (
    <div className="grid gap-4">
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
      <div className={clsx("grid gap-3", !compact && "sm:grid-cols-2")}>
        <div>
          <label className="label" htmlFor={`${id}-name`}>Name (optional)</label>
          <input id={`${id}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-email`}>Email for a receipt (optional)</label>
          <input id={`${id}-email`} className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-2">
        <input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} /> Show my name on the fund&apos;s ledger
      </label>
      {data.returns && (
        <label className="flex items-start gap-2.5 rounded-lg border border-line bg-sunken p-3 text-sm">
          <input type="checkbox" className="mt-0.5" checked={returnOptIn} onChange={(e) => setReturnOptIn(e.target.checked)} />
          <span>
            <span className="font-medium inline-flex items-center gap-1.5"><Undo2 className="h-4 w-4 text-ink-2" aria-hidden /> Return my share of anything left when the relief work ends</span>
            <span className="block text-xs text-ink-2 mt-1">
              If {data.ngo.name || "the NGO"} closes this fund with money left over, you get back the same share of it as your gift is of everything the fund raised (give 1% of the total, get 1% of what&apos;s left). It&apos;s sent to the PayPal account you pay with. Leave it unticked and your share stays with {data.ngo.name || "the NGO"} for other relief work.
            </span>
          </span>
        </label>
      )}

      {!valid && <p className="text-sm text-critical">Give between {usd(data.limits.min)} and {usd(data.limits.max)}.</p>}
      {preview ? (
        <div>
          <button type="button" className="btn btn-primary w-full justify-center !py-3" disabled>Donate {valid ? usd(cents) : ""} with PayPal</button>
          <p className="text-xs text-muted mt-1">Preview: on your website this shows PayPal&apos;s buttons.</p>
        </div>
      ) : data.paypal.live ? (
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
      {fund.code && (
        <p className="text-xs text-ink-2 flex items-start gap-1.5">
          <Landmark className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />
          <span>PayPal gifts carry tracking code <span className="font-mono font-semibold text-ink">#{fund.code}</span> automatically. Paying by bank transfer instead? Put it in the payment reference so it&apos;s matched to this fund.</span>
        </p>
      )}
    </div>
  );
}
