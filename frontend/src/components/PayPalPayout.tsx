"use client";

import { useState } from "react";
import { Loader2, Paperclip, Send, X } from "lucide-react";
import clsx from "clsx";
import { api, useJson, usd } from "./hooks";
import { CAT_LABEL } from "./SpendCard";

type PayFrom = { id: string; title: string; account: string; live: boolean; simulated: boolean; canSend: boolean };
type Vendor = { id: string; name: string; paypalEmail: string; verified?: boolean };

/**
 * Pay someone through PayPal from a fund: a PayPal payout from the fund's own
 * PayPal account, recorded on the fund's ledger. Only for admins and staff an
 * admin allowed (Settings → Team), from the funds they're on.
 */
export function PayPalPayout({ onDone }: { onDone: (message: string) => void }) {
  // Payees' PayPal emails come only with this (for people allowed to pay).
  const { data } = useJson<{ canPay: boolean; payFrom: PayFrom[]; payees: Vendor[] }>("/api/payments");
  const [f, setF] = useState({ fundId: "", vendorId: "", payee: "", email: "", amountUsd: "", category: "", description: "" });
  const [file, setFile] = useState<{ id: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const funds = data?.payFrom ?? [];
  const fund = funds.find((x) => x.id === (f.fundId || funds[0]?.id));
  const list = data?.payees ?? [];
  const cents = Math.round(Number(f.amountUsd || 0) * 100);
  const ready = fund?.canSend && f.payee.trim() && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim()) && cents > 0 && f.description.trim().length >= 3;

  function pickVendor(id: string) {
    const v = list.find((x) => x.id === id);
    setF({ ...f, vendorId: id, payee: v?.name ?? "", email: v?.paypalEmail ?? "" });
  }

  async function attach(fl: File) {
    setUploading(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", fl);
      fd.append("read", "0");
      const res = await fetch("/api/payments/scan", { method: "POST", body: fd });
      const j = (await res.json().catch(() => ({}))) as { fileId?: string; fileName?: string; error?: string };
      if (!res.ok || !j.fileId) throw new Error(j.error || "Upload failed");
      setFile({ id: j.fileId, name: j.fileName ?? fl.name });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function send() {
    if (!fund) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ message: string }>("/api/payments", {
        json: { action: "paypal", fundId: fund.id, amountUsd: Number(f.amountUsd), payee: f.payee, email: f.email, description: f.description, category: f.category || undefined, fileId: file?.id },
      });
      onDone(r.message);
    } catch (e) {
      setErr((e as Error).message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  if (data && !data.canPay) return <section className="card p-5 mb-5 text-sm text-ink-2">You aren&apos;t allowed to send PayPal payments. An admin can allow it under Settings → Team.</section>;

  return (
    <section className="card p-5 mb-5 border-brand">
      <h2 className="font-semibold">Pay someone via PayPal</h2>
      <p className="text-xs text-ink-2 mt-0.5 max-w-3xl">
        Sends a PayPal payment from the fund&apos;s own PayPal account to the payee&apos;s PayPal email, and puts it on the fund&apos;s ledger and the audit log under your name. If PayPal sends it back (no such account, refused), it&apos;s voided and the money returns to the fund.
      </p>
      {!data ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted mt-4" />
      ) : !funds.length ? (
        <p className="text-sm text-ink-2 mt-4">You&apos;re not on any open fund to pay from.</p>
      ) : (
        <form className="mt-4 grid sm:grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); if (ready) setConfirming(true); }}>
          <div>
            <label className="label" htmlFor="pp-fund">Pay from</label>
            <select id="pp-fund" className="input" value={fund?.id} onChange={(e) => setF({ ...f, fundId: e.target.value })}>
              {funds.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
            {fund && (
              <span className={clsx("text-xs", fund.canSend ? "text-muted" : "text-critical")}>
                {fund.canSend ? `From "${fund.account}"${fund.simulated ? " (simulated: no money moves)" : ""}` : `"${fund.account}" can't send payouts (connected by login, or its keys aren't working)`}
              </span>
            )}
          </div>
          <div>
            <label className="label" htmlFor="pp-vendor">Payee</label>
            <select id="pp-vendor" className="input" value={f.vendorId} onChange={(e) => pickVendor(e.target.value)}>
              <option value="">Someone else (type their details)</option>
              {list.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div><label className="label" htmlFor="pp-name">Paid to</label><input id="pp-name" className="input" value={f.payee} onChange={(e) => setF({ ...f, payee: e.target.value, vendorId: "" })} placeholder="Name of the person or business" /></div>
          <div><label className="label" htmlFor="pp-email">Their PayPal email</label><input id="pp-email" className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value, vendorId: "" })} placeholder="name@example.com" /></div>
          <div><label className="label" htmlFor="pp-amt">Amount (USD)</label><input id="pp-amt" className="input tnum" type="number" min="0.01" max="10000" step="0.01" value={f.amountUsd} onChange={(e) => setF({ ...f, amountUsd: e.target.value })} /></div>
          <div><label className="label" htmlFor="pp-cat">Category</label><select id="pp-cat" className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">Uncategorised</option>{Object.entries(CAT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div className="sm:col-span-2"><label className="label" htmlFor="pp-desc">What it&apos;s for</label><input id="pp-desc" className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Boat hire for the Kendrapara supply run" /><span className="text-xs text-muted">Shown on the fund&apos;s ledger (a private person&apos;s name is replaced there) and in the payee&apos;s PayPal note.</span></div>
          <div className="sm:col-span-2">
            <span className="label">Invoice or receipt (optional)</span>
            {file ? (
              <span className="inline-flex items-center gap-2 text-sm rounded-lg border border-line px-3 py-1.5">{file.name}<button type="button" onClick={() => setFile(null)} aria-label="Remove the file" className="text-muted hover:text-critical"><X className="h-4 w-4" /></button></span>
            ) : (
              <label className={clsx("inline-flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-1.5 text-sm cursor-pointer hover:border-brand", uploading && "opacity-70 pointer-events-none")}>
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4 text-brand" />} Attach an image or PDF
                <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only" onChange={(e) => { const x = e.target.files?.[0]; e.target.value = ""; if (x) void attach(x); }} />
              </label>
            )}
          </div>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
            {confirming ? (
              <>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>Back</button>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={send}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Yes, send {usd(cents)} to {f.email.trim()}
                </button>
                <span className="text-xs text-muted">{fund?.simulated ? "Simulated: no money moves." : "The money leaves the PayPal account now."}</span>
              </>
            ) : (
              <button className="btn btn-primary" disabled={!ready}><Send className="h-4 w-4" /> Pay {cents > 0 ? usd(cents) : ""} via PayPal…</button>
            )}
          </div>
        </form>
      )}
      {err && <p className="text-sm text-critical mt-3" role="alert">{err}</p>}
    </section>
  );
}
