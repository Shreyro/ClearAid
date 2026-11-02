"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Lock, Loader2 } from "lucide-react";
import clsx from "clsx";
import { api, useJson, usd } from "./hooks";

type Cfg = { paypal: { live: boolean; env: string; clientId: string | null; sdkUrl: string } };
type CaptureResp = { donationId: string; captureId: string; amount: number; simulated: boolean; ledgerSeq: number; hash: string };

/* Minimal typing for the PayPal JavaScript SDK v6 surface we use. */
type PayPalSession = { start: (opts: { presentationMode: "auto" | "popup" | "modal" }, order: Promise<{ orderId: string }>) => Promise<void> };
type PayPalSdk = {
  createInstance: (o: { clientId: string; components: string[]; pageType: string }) => Promise<{
    findEligibleMethods: (o: { currencyCode: string }) => Promise<{ isEligible: (m: string) => boolean }>;
    createPayPalOneTimePaymentSession: (o: {
      onApprove: (d: { orderId: string }) => Promise<void>;
      onCancel: (d?: { orderId?: string }) => void;
      onError: (e: Error) => void;
    }) => PayPalSession;
  }>;
};
declare global {
  interface Window {
    paypal?: PayPalSdk;
  }
}

const PRESETS = [10, 25, 50, 100, 250];

export function DonateBox({ fund, onDonated }: { fund: { id: string; title: string; status: string }; onDonated: () => void }) {
  const { data: cfg } = useJson<Cfg>("/api/config");
  const [amount, setAmount] = useState(25);
  const [custom, setCustom] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [showName, setShowName] = useState(false);
  const [phase, setPhase] = useState<"idle" | "busy" | "sim" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CaptureResp | null>(null);
  const [sdkReady, setSdkReady] = useState(false);
  const session = useRef<PayPalSession | null>(null);

  // Called from the click handler, so it always sees the current form state.
  async function createOrder(): Promise<{ orderId: string }> {
    const r = await api<{ id: string }>("/api/paypal/orders", {
      json: { fundId: fund.id, amountUsd: custom ? Number(custom) : amount, name, email, showName },
    });
    return { orderId: r.id };
  }

  async function capture(orderId: string) {
    setPhase("busy");
    try {
      const r = await api<CaptureResp>(`/api/paypal/orders/${orderId}/capture`, { method: "POST" });
      setResult(r);
      setPhase("done");
      onDonated();
      window.dispatchEvent(new Event("clearaid:persona"));
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  }

  // Live mode: PayPal JavaScript SDK v6 one-time payment session.
  useEffect(() => {
    if (!cfg?.paypal.live || !cfg.paypal.clientId) return;
    let cancelled = false;
    const init = async () => {
      try {
        const sdk = await window.paypal!.createInstance({ clientId: cfg.paypal.clientId!, components: ["paypal-payments"], pageType: "checkout" });
        const methods = await sdk.findEligibleMethods({ currencyCode: "USD" });
        if (cancelled || !methods.isEligible("paypal")) return;
        session.current = sdk.createPayPalOneTimePaymentSession({
          onApprove: async (d) => capture(d.orderId),
          onCancel: () => setPhase("idle"),
          onError: (e) => {
            setError(e.message || "PayPal checkout failed");
            setPhase("idle");
          },
        });
        setSdkReady(true);
      } catch (e) {
        setError(`PayPal SDK failed to load: ${(e as Error).message}`);
      }
    };
    if (window.paypal) void init();
    else {
      let s = document.querySelector<HTMLScriptElement>(`script[src="${cfg.paypal.sdkUrl}"]`);
      if (!s) {
        s = document.createElement("script");
        s.src = cfg.paypal.sdkUrl;
        s.async = true;
        document.head.appendChild(s);
      }
      s.addEventListener("load", () => void init());
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.paypal.live, cfg?.paypal.clientId]);

  function startLive() {
    setError(null);
    if (!session.current) return;
    // Don't await createOrder before start(): the SDK needs the click's transient activation.
    session.current.start({ presentationMode: "auto" }, createOrder()).catch((e: Error) => setError(e.message));
  }

  async function approveSimulated() {
    try {
      setPhase("busy");
      const { orderId } = await createOrder();
      await capture(orderId);
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  }

  const value = custom ? Number(custom) : amount;
  const valid = value >= 1 && value <= 10000;

  if (fund.status !== "active") {
    return (
      <div className="card p-5">
        <h2 className="font-semibold">This fund is {fund.status === "closing" ? "closing" : "closed"}</h2>
        <p className="text-sm text-ink-2 mt-1">It no longer accepts donations. {fund.status === "closing" ? "Donors are choosing whether to get their unspent share back or carry it forward." : ""}</p>
        <Link href="/me" className="btn btn-ghost mt-3 w-full">
          Donated? Choose what happens to your share
        </Link>
      </div>
    );
  }

  if (phase === "done" && result) {
    return (
      <div className="card p-5">
        <CheckCircle2 className="h-8 w-8 text-good" />
        <h2 className="font-semibold mt-2">Thank you. {usd(result.amount)} is in the fund.</h2>
        <p className="text-sm text-ink-2 mt-1">Your gift is ledger entry #{result.ledgerSeq}. It can only leave the fund as an audited payment to a verified vendor, and you can follow it from your impact page.</p>
        <div className="mt-3 rounded-lg bg-[#f7f7f3] p-3 text-xs font-mono break-all text-ink-2">
          capture {result.captureId}
          <br />
          sha256 {result.hash.slice(0, 32)}…
        </div>
        <div className="flex gap-2 mt-4">
          <Link href="/me" className="btn btn-primary flex-1">
            Follow my dollar
          </Link>
          <button className="btn btn-ghost" onClick={() => { setPhase("idle"); setResult(null); }}>
            Give again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <h2 className="font-semibold">Donate to this fund</h2>
      <p className="text-xs text-ink-2 mt-1">100% goes into this fund&apos;s ledger. Unspent money is returned or carried forward, as you choose.</p>
      <div className="grid grid-cols-5 gap-1.5 mt-4">
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => { setAmount(p); setCustom(""); }}
            className={clsx("rounded-lg border py-2 text-sm font-semibold", !custom && amount === p ? "border-brand bg-brand-wash text-brand-ink" : "border-line hover:border-line-strong")}
          >
            ${p}
          </button>
        ))}
      </div>
      <input className="input mt-2" inputMode="decimal" placeholder="Other amount (USD)" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ""))} />
      <div className="grid grid-cols-2 gap-2 mt-2">
        <input className="input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" placeholder="Email for receipt" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <label className="flex items-center gap-2 text-xs text-ink-2 mt-2">
        <input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} /> Show my name on the public ledger (otherwise anonymous)
      </label>

      <div className="mt-4">
        {cfg?.paypal.live ? (
          sdkReady ? (
            <paypal-button type="pay" onClick={valid ? startLive : undefined} style={{ opacity: valid ? 1 : 0.5 }} />
          ) : (
            <div className="h-11 rounded-lg bg-[#f1f0ec] grid place-items-center text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )
        ) : (
          <button disabled={!valid || phase === "busy"} onClick={() => setPhase("sim")} className="w-full h-11 rounded-full font-bold text-paypal disabled:opacity-50" style={{ background: "var(--paypal-gold)" }}>
            {phase === "busy" ? <Loader2 className="h-4 w-4 animate-spin inline" /> : <>Donate {valid ? `$${value}` : ""} with <span className="italic">PayPal</span></>}
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted mt-2 flex items-center gap-1">
        <Lock className="h-3 w-3" /> {cfg?.paypal.live ? `PayPal ${cfg.paypal.env} checkout (JavaScript SDK v6)` : "Demo mode: PayPal is simulated, no real money moves"}
      </p>
      {error && <p className="text-sm text-critical mt-2">{error}</p>}

      {phase === "sim" && (
        <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onClick={() => setPhase("idle")}>
          <div className="card w-full max-w-sm p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-xl font-bold italic text-paypal">PayPal</div>
            <div className="text-xs text-muted">Simulated sandbox checkout</div>
            <div className="mt-4 rounded-lg bg-[#f7f7f3] p-3 text-sm">
              <div className="text-muted text-xs">Donation to</div>
              <div className="font-medium">{fund.title}</div>
              <div className="text-2xl font-semibold mt-2">${value.toFixed(2)} USD</div>
            </div>
            <p className="text-xs text-ink-2 mt-3">Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to use the real PayPal v6 checkout in the sandbox.</p>
            <div className="flex gap-2 mt-4">
              <button className="btn btn-ghost flex-1" onClick={() => setPhase("idle")}>
                Cancel
              </button>
              <button className="flex-1 rounded-full font-bold text-white bg-paypal" onClick={approveSimulated}>
                Pay now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
