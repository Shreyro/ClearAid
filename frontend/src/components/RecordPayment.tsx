"use client";

import { useState } from "react";
import { AlertTriangle, FileText, Link2Off, Loader2, Paperclip, PenLine, ScanLine, Upload, X } from "lucide-react";
import clsx from "clsx";
import { api, useJson, useLive, usd } from "./hooks";
import { CAT_LABEL } from "./SpendCard";
import { Empty, Pill } from "./ui";

type Extraction = {
  supplier: string | null;
  invoiceNumber: string | null;
  date: string | null;
  currency: string | null;
  total: number | null;
  printedCode: string | null;
  lineItems: { description: string; amount: number | null }[];
  legible: boolean;
};
type Scan = { fileId: string; fileName: string; url: string; engine: "local" | "claude" | "none"; extraction: Extraction | null; note?: string; suggestion: { fundId?: string; category?: string; code?: string } };

const METHODS: [string, string][] = [
  ["bank_transfer", "Bank transfer"],
  ["card", "Card"],
  ["cheque", "Cheque"],
  ["cash", "Cash"],
  ["other", "Other (no bank line)"],
];
const fromBank = (m: string) => m === "bank_transfer" || m === "card" || m === "cheque";
const today = () => new Date().toISOString().slice(0, 10);

/** Upload a receipt or invoice. `read: false` stores and hashes it without the AI reading it. */
async function uploadReceipt(file: File, read: boolean): Promise<Scan> {
  const fd = new FormData();
  fd.append("file", file);
  if (!read) fd.append("read", "0");
  const res = await fetch("/api/payments/scan", { method: "POST", body: fd });
  const j = (await res.json().catch(() => ({}))) as Scan & { error?: string };
  if (!res.ok) throw new Error(j.error || `Upload failed (${res.status})`);
  return j;
}

/**
 * Declare money out of a fund, two ways: upload the receipt or invoice and
 * the local AI model fills in the form for the person to check, or type the details in by
 * hand and attach the receipt if there is one (it can also be attached later).
 */
export function RecordPayment({ funds, isAdmin, onDone }: { funds: { id: string; title: string }[]; isAdmin: boolean; onDone: (message: string) => void }) {
  const [mode, setMode] = useState<"ai" | "manual">("ai");
  const [scan, setScan] = useState<Scan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [f, setF] = useState({ fundId: funds[0]?.id ?? "", category: "", amountUsd: "", payee: "", date: today(), method: "bank_transfer", invoiceNumber: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  async function upload(file: File) {
    setScanning(true);
    setErr(null);
    setConflict(false);
    try {
      const j = await uploadReceipt(file, mode === "ai");
      setScan(j);
      // Manual entry: the file is only attached; what's typed stays as it is.
      if (mode === "manual") return;
      const x = j.extraction;
      // Pre-fill from what was read; the person checks every field before saving.
      setF((cur) => ({
        ...cur,
        fundId: j.suggestion.fundId && funds.some((fd) => fd.id === j.suggestion.fundId) ? j.suggestion.fundId : cur.fundId,
        category: j.suggestion.category ?? cur.category,
        amountUsd: x?.total != null ? x.total.toFixed(2) : cur.amountUsd,
        payee: x?.supplier ?? cur.payee,
        date: x?.date && /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.date <= today() ? x.date : cur.date,
        invoiceNumber: x?.invoiceNumber ?? cur.invoiceNumber,
        description: cur.description || summarise(x),
      }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function save(force = false) {
    if (!scan && mode === "ai") return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ message: string }>("/api/payments", { json: { action: "create", fileId: scan?.fileId, ...f, category: f.category || undefined, amountUsd: Number(f.amountUsd), force } });
      onDone(r.message);
    } catch (e) {
      const m = (e as Error).message;
      setErr(m);
      setConflict(m.includes("record it anyway"));
    } finally {
      setBusy(false);
    }
  }

  const switchMode = (m: "ai" | "manual") => {
    if (m === mode) return;
    setMode(m);
    setScan(null);
    setErr(null);
    setConflict(false);
  };
  const x = scan?.extraction;
  const notUsd = x?.currency && x.currency.toUpperCase() !== "USD";
  const differs = (field: "amount" | "payee" | "date" | "invoice") => {
    if (!x) return false;
    if (field === "amount") return x.total != null && Number(f.amountUsd).toFixed(2) !== x.total.toFixed(2);
    if (field === "payee") return Boolean(x.supplier) && x.supplier!.trim().toLowerCase() !== f.payee.trim().toLowerCase();
    if (field === "date") return Boolean(x.date) && x.date !== f.date;
    return Boolean(x.invoiceNumber) && x.invoiceNumber !== f.invoiceNumber;
  };
  const edited = (d: boolean) => (d ? <span className="ml-1 text-xs font-normal text-warn-ink">changed from receipt</span> : null);

  return (
    <section className="card p-5 mb-5 border-brand">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Record a payment</h2>
          <p className="text-xs text-ink-2 mt-0.5 max-w-3xl">
            Money paid out of a fund. {mode === "ai" ? "Upload the receipt or invoice (a photo or a PDF): it's read on this machine (OCR, then the local AI model) and the details are filled in for you to check." : "Type the details in, and attach the receipt or invoice if you have it (you can also attach it later)."} It goes on the fund&apos;s ledger and the audit log under your name. A bank payment is matched to its bank line when the statement comes in, so it&apos;s only counted once. {!isAdmin && "You can record for funds you're an approver on."}
          </p>
        </div>
        <div className="flex rounded-lg border border-line p-1 text-xs font-semibold shrink-0" role="radiogroup" aria-label="How to fill in the payment">
          <button type="button" role="radio" aria-checked={mode === "ai"} className={clsx("rounded-md px-3 py-1.5 inline-flex items-center gap-1.5", mode === "ai" ? "bg-brand text-white" : "text-ink-2")} onClick={() => switchMode("ai")}>
            <ScanLine className="h-3.5 w-3.5" aria-hidden /> Read the receipt
          </button>
          <button type="button" role="radio" aria-checked={mode === "manual"} className={clsx("rounded-md px-3 py-1.5 inline-flex items-center gap-1.5", mode === "manual" ? "bg-brand text-white" : "text-ink-2")} onClick={() => switchMode("manual")}>
            <PenLine className="h-3.5 w-3.5" aria-hidden /> Enter by hand
          </button>
        </div>
      </div>

      {mode === "ai" && !scan ? (
        <label
          className={clsx("mt-4 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line p-8 text-center cursor-pointer hover:border-brand", scanning && "opacity-70 pointer-events-none")}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file) void upload(file);
          }}
        >
          {scanning ? <Loader2 className="h-6 w-6 animate-spin text-brand" /> : <Upload className="h-6 w-6 text-brand" />}
          <span className="font-medium">{scanning ? "Reading the receipt…" : "Upload the receipt or invoice"}</span>
          <span className="text-xs text-muted">Image or PDF, up to 8 MB. Drop it here or click to choose.</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            className="sr-only"
            disabled={scanning}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
      ) : (
        <div className={clsx("mt-4 grid gap-5", scan && mode === "ai" && "lg:grid-cols-[300px_minmax(0,1fr)]")}>
          {mode === "ai" && scan && (
          <aside className="rounded-lg border border-line p-3 text-xs space-y-2 h-fit">
            <a href={scan.url} target="_blank" rel="noreferrer" className="font-medium inline-flex items-center gap-1 underline break-all">
              <FileText className="h-3.5 w-3.5 shrink-0" /> {scan.fileName}
            </a>
            {(scan.engine === "local" || scan.engine === "claude") && x ? (
              <>
                <div className="flex items-center gap-1.5 text-ink-2"><ScanLine className="h-3.5 w-3.5 text-brand" /> Read by the local AI model{!x.legible && <Pill tone="warn">Hard to read</Pill>}</div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-ink-2">
                  <dt className="text-muted">Supplier</dt><dd>{x.supplier ?? "—"}</dd>
                  <dt className="text-muted">Invoice no.</dt><dd>{x.invoiceNumber ?? "—"}</dd>
                  <dt className="text-muted">Date</dt><dd>{x.date ?? "—"}</dd>
                  <dt className="text-muted">Total</dt><dd>{x.total != null ? `${x.currency ?? ""} ${x.total.toLocaleString()}`.trim() : "—"}</dd>
                  {x.printedCode && <><dt className="text-muted">Code</dt><dd>#{x.printedCode}{scan.suggestion.fundId ? "" : " (not one of your funds)"}</dd></>}
                </dl>
                {x.lineItems.length > 0 && (
                  <ul className="border-t border-line pt-2 space-y-0.5">
                    {x.lineItems.slice(0, 12).map((li, i) => (
                      <li key={i} className="flex justify-between gap-2"><span className="truncate">{li.description}</span><span className="tnum shrink-0">{li.amount != null ? li.amount.toLocaleString() : ""}</span></li>
                    ))}
                    {x.lineItems.length > 12 && <li className="text-muted">+{x.lineItems.length - 12} more lines</li>}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-muted">{scan.note ?? "Not read automatically."} Fill in the details from the receipt.</p>
            )}
            <button type="button" className="text-muted underline" onClick={() => { setScan(null); setErr(null); setConflict(false); }}>Use a different file</button>
          </aside>
          )}

          <form
            className="grid sm:grid-cols-2 gap-3 content-start"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {notUsd && (
              <p className="sm:col-span-2 text-xs rounded-lg bg-warn-wash text-warn-ink p-2 flex gap-1.5"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> This receipt is in {x!.currency}. Enter the amount in USD as it left the account.</p>
            )}
            <div><label className="label" htmlFor="px-fund">Fund</label><select id="px-fund" className="input" value={f.fundId} onChange={(e) => setF({ ...f, fundId: e.target.value })}>{funds.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select>{scan?.suggestion.code && <span className="text-xs text-muted">Suggested by #{scan.suggestion.code} on the receipt</span>}</div>
            <div><label className="label" htmlFor="px-cat">Category</label><select id="px-cat" className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">Uncategorised</option>{Object.entries(CAT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div><label className="label" htmlFor="px-payee">Paid to{edited(differs("payee"))}</label><input id="px-payee" className="input" placeholder="Supplier or person" value={f.payee} onChange={(e) => setF({ ...f, payee: e.target.value })} /></div>
            <div><label className="label" htmlFor="px-amt">Amount (USD){edited(differs("amount"))}</label><input id="px-amt" className="input tnum" type="number" min="0.01" step="0.01" value={f.amountUsd} onChange={(e) => setF({ ...f, amountUsd: e.target.value })} /></div>
            <div><label className="label" htmlFor="px-date">Paid on{edited(differs("date"))}</label><input id="px-date" className="input" type="date" max={today()} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
            <div>
              <label className="label" htmlFor="px-method">Paid by</label>
              <select id="px-method" className="input" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <span className="text-xs text-muted">{fromBank(f.method) ? "Will be matched to its bank line" : "No bank line expected"}</span>
            </div>
            <div><label className="label" htmlFor="px-inv">Invoice / receipt no.{edited(differs("invoice"))}</label><input id="px-inv" className="input font-mono" value={f.invoiceNumber} onChange={(e) => setF({ ...f, invoiceNumber: e.target.value })} /></div>
            {mode === "manual" && (
              <div className="sm:col-span-2">
                <span className="label">Receipt or invoice (optional)</span>
                {scan ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                    <FileText className="h-4 w-4 text-ink-2 shrink-0" aria-hidden />
                    <a href={scan.url} target="_blank" rel="noreferrer" className="underline break-all">{scan.fileName}</a>
                    <button type="button" className="ml-auto p-1 text-muted hover:text-critical rounded" onClick={() => setScan(null)} aria-label="Remove the attached file"><X className="h-4 w-4" /></button>
                  </div>
                ) : (
                  <label className={clsx("flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-sm cursor-pointer hover:border-brand", scanning && "opacity-70 pointer-events-none")}>
                    {scanning ? <Loader2 className="h-4 w-4 animate-spin text-brand" /> : <Paperclip className="h-4 w-4 text-brand" aria-hidden />}
                    <span>{scanning ? "Attaching…" : "Attach an image or PDF"}</span>
                    <span className="text-xs text-muted">stored as evidence, not read by AI</span>
                    <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only" disabled={scanning} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void upload(file); }} />
                  </label>
                )}
                {!scan && <span className="text-xs text-muted">No receipt to hand? Record it now and attach it later from the list of declared payments.</span>}
              </div>
            )}
            <div className="sm:col-span-2"><label className="label" htmlFor="px-desc">What it was for</label><input id="px-desc" className="input" placeholder="e.g. 200 tarpaulins for Kendrapara shelters" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /><span className="text-xs text-muted">Shown on the fund&apos;s ledger. A private person&apos;s name is replaced there, as on bank lines.</span></div>
            <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
              <button className="btn btn-primary" disabled={busy || !f.fundId || !f.amountUsd || !f.payee.trim() || f.description.trim().length < 3}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Add to ledger</button>
              {conflict && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void save(true)}>It&apos;s a different payment: record anyway</button>}
            </div>
          </form>
        </div>
      )}
      {err && <p className="text-sm text-critical mt-3" role="alert">{err}</p>}
    </section>
  );
}

function summarise(x: Extraction | null) {
  if (!x?.lineItems.length) return "";
  const first = x.lineItems.slice(0, 2).map((l) => l.description).join(", ");
  return (x.lineItems.length > 2 ? `${first} and ${x.lineItems.length - 2} more` : first).slice(0, 200);
}

type Payment = {
  id: string;
  fundTitle: string;
  category?: string;
  amount: number;
  payee: string;
  date: string;
  methodLabel: string;
  invoiceNumber?: string;
  description: string;
  status: "awaiting_bank" | "matched" | "no_bank" | "void";
  receipt?: { url: string; fileName: string; edited?: string[] };
  bankLine?: { id: string; date: string; description: string };
  byId: string;
  byName: string;
  voidReason?: string;
  voidedBy?: string;
};

const STATUS: Record<Payment["status"], { label: string; tone: "good" | "warn" | "neutral" | "bad" }> = {
  awaiting_bank: { label: "Waiting for bank line", tone: "warn" },
  matched: { label: "Bank line matched", tone: "good" },
  no_bank: { label: "No bank line", tone: "neutral" },
  void: { label: "Voided", tone: "bad" },
};

/** Payments declared by hand, with their receipt and whether their bank line has turned up. */
export function DeclaredPayments({ meId, isAdmin, onChanged }: { meId: string; isAdmin: boolean; onChanged: (m: string) => void }) {
  const { data, reload } = useJson<{ payments: Payment[] }>("/api/payments");
  const [busy, setBusy] = useState<string | null>(null);

  async function attach(id: string, file: File) {
    setBusy(id);
    setErr(null);
    try {
      const scan = await uploadReceipt(file, true);
      const r = await api<{ message: string }>("/api/payments", { json: { action: "attach", id, fileId: scan.fileId } });
      await reload();
      onChanged(r.message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useLive(undefined, (e) => {
    if (e.kind === "ledger" || e.kind === "bank") void reload();
  });

  async function act(id: string, body: Record<string, unknown>) {
    setBusy(id);
    setErr(null);
    try {
      const r = await api<{ message: string }>("/api/payments", { json: { id, ...body } });
      setVoiding(null);
      setReason("");
      await reload();
      onChanged(r.message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const list = data?.payments ?? [];
  const waiting = list.filter((p) => p.status === "awaiting_bank").length;
  if (data && !list.length) return null;
  return (
    <details className="card mb-4 group">
      <summary className="px-4 py-3 cursor-pointer text-sm font-semibold flex flex-wrap items-center gap-2">
        Declared payments <span className="text-muted font-normal">({list.length})</span>
        {waiting > 0 && <Pill tone="warn">{waiting} waiting for a bank line</Pill>}
      </summary>
      {!data ? (
        <div className="h-20 animate-pulse" />
      ) : !list.length ? (
        <Empty>No payments declared yet.</Empty>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {list.map((p) => (
            <li key={p.id} className={clsx("px-4 py-3 text-sm", p.status === "void" && "opacity-60")}>
              <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
                <div className="flex-1 min-w-[14rem]">
                  <div className="font-medium">{p.payee} <span className="tnum">· {usd(p.amount)}</span></div>
                  <div className="text-xs text-ink-2">{p.description}</div>
                  <div className="text-xs text-muted mt-0.5">
                    {p.fundTitle}{p.category ? ` · ${CAT_LABEL[p.category] ?? p.category}` : ""} · {p.date} · {p.methodLabel}{p.invoiceNumber ? ` · No. ${p.invoiceNumber}` : ""} · by {p.byName}
                  </div>
                  {p.bankLine && <div className="text-xs text-ink-2 mt-0.5">Bank line: {p.bankLine.date} &ldquo;{p.bankLine.description}&rdquo;</div>}
                  {p.receipt?.edited?.length ? <div className="text-xs text-warn-ink mt-0.5">Changed from the receipt: {p.receipt.edited.join(", ")}</div> : null}
                  {p.status === "void" && <div className="text-xs text-critical mt-0.5">Voided by {p.voidedBy}: {p.voidReason}</div>}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Pill>
                  {p.receipt && <a href={p.receipt.url} target="_blank" rel="noreferrer" className="btn btn-ghost !py-1 text-xs"><FileText className="h-3.5 w-3.5" /> Receipt</a>}
                  {!p.receipt && p.status !== "void" && (
                    <>
                      <Pill tone="warn">No receipt</Pill>
                      <label className={clsx("btn btn-ghost !py-1 text-xs cursor-pointer", busy === p.id && "opacity-60 pointer-events-none")} title="Attach the receipt or invoice for this payment">
                        {busy === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />} Attach receipt
                        <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void attach(p.id, file); }} />
                      </label>
                    </>
                  )}
                  {p.status === "matched" && (
                    <button className="btn btn-ghost !py-1 text-xs" disabled={busy === p.id} onClick={() => act(p.id, { action: "unlink" })} title="Wrong bank line? Send it back to the Untagged queue">
                      <Link2Off className="h-3.5 w-3.5" /> Unlink
                    </button>
                  )}
                  {p.status !== "void" && (isAdmin || p.byId === meId) && (
                    <button className="btn btn-ghost !py-1 text-xs text-critical" disabled={busy === p.id} onClick={() => { setVoiding(voiding === p.id ? null : p.id); setReason(""); }}>Void</button>
                  )}
                </div>
              </div>
              {voiding === p.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input className="input !py-1.5 text-sm flex-1 min-w-[14rem]" placeholder="Why? e.g. Recorded twice / wrong fund" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for voiding" />
                  <button className="btn btn-danger !py-1.5 text-xs" disabled={busy === p.id || reason.trim().length < 3} onClick={() => act(p.id, { action: "void", reason })}>
                    {busy === p.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Void and post it back
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {err && <p className="text-sm text-critical px-4 pb-3" role="alert">{err}</p>}
    </details>
  );
}
