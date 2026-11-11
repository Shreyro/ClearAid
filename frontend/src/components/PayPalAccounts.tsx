"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Copy, CreditCard, KeyRound, Loader2, Pencil, Plus, Unplug, X } from "lucide-react";
import clsx from "clsx";
import { api, ago, useJson, useLive, usd } from "./hooks";
import { Pill } from "./ui";

export type PayPalAccount = {
  id: string;
  name: string;
  email?: string;
  env: "sandbox" | "live";
  mode: "live" | "simulated";
  live: boolean;
  builtin: boolean;
  clientId: string | null;
  webhooks: boolean;
  webhookUrl: string;
  status: "active" | "disconnected";
  createdAt: string | null;
  funds: { id: string; title: string; slug: string }[];
  received: number;
  refunded: number;
  gifts: number;
};

/** The NGO's PayPal accounts: what each collected, which funds pay into it, and (admins) adding and managing them. */
export function PayPalAccounts({ isAdmin }: { isAdmin: boolean }) {
  const { data, reload } = useJson<{ accounts: PayPalAccount[] }>("/api/paypal/accounts");
  useLive(undefined, (e) => {
    if (e.kind === "bank" || e.kind === "fund" || e.kind === "ledger") void reload();
  });
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const done = (text: string) => {
    setMsg({ text });
    void reload();
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="text-lg font-semibold">PayPal accounts {data && <span className="text-muted font-normal text-base">({data.accounts.length})</span>}</h2>
        {isAdmin && (
          <button className="btn btn-ghost" onClick={() => setAdding((a) => !a)}>
            {adding ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />} PayPal account
          </button>
        )}
      </div>
      <p className="text-sm text-ink-2 mb-4 max-w-3xl">
        Each fund&apos;s donation link pays into one PayPal account, so you can keep appeals or offices apart. Refunds and webhooks go through the account the gift landed in.
        {isAdmin && <> Choose a fund&apos;s account under <Link href="/settings?tab=funds" className="underline">Settings → Funds</Link>.</>}
      </p>
      {adding && <AddPayPalAccount onDone={(m) => { setAdding(false); done(m); }} />}
      {msg && <div role="status" className={clsx("card p-3 text-sm mb-4", msg.bad ? "bg-bad-wash border-bad-line text-bad-ink" : "bg-brand-wash border-brand-line")}>{msg.text}</div>}
      {!data ? (
        <div className="card p-6"><Loader2 className="h-5 w-5 animate-spin text-muted" /></div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-4">
          {data.accounts.map((a) => <AccountCard key={a.id} a={a} isAdmin={isAdmin} onDone={done} onError={(text) => setMsg({ text, bad: true })} />)}
        </div>
      )}
    </div>
  );
}

function AccountCard({ a, isAdmin, onDone, onError }: { a: PayPalAccount; isAdmin: boolean; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const active = a.status === "active";

  async function toggle() {
    setBusy(true);
    try {
      await api("/api/paypal/accounts", { json: { action: active ? "disconnect" : "reconnect", id: a.id } });
      onDone(active ? `${a.name} disconnected. Gifts already recorded are kept${a.funds.length ? `; new gifts to ${a.funds.map((f) => f.title).join(", ")} go to the main account until you reconnect it` : ""}.` : `${a.name} reconnected.`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={clsx("card p-5 flex flex-col gap-4", !active && "opacity-70")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-info-wash text-paypal grid place-items-center shrink-0"><CreditCard className="h-5 w-5" /></div>
          <div className="min-w-0">
            <h3 className="font-semibold truncate">{a.name}</h3>
            <div className="text-xs text-muted flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
              {a.builtin && <Pill>Main</Pill>}
              {a.live ? <Pill tone="info">PayPal {a.env}</Pill> : a.mode === "live" ? <Pill tone="bad">Keys not working</Pill> : <Pill tone="warn">Simulated</Pill>}
              {!active && <Pill tone="bad">Disconnected</Pill>}
              {a.email && <span className="truncate">{a.email}</span>}
              {a.clientId && <span className="font-mono">{a.clientId}</span>}
              {a.createdAt && <span>added {ago(a.createdAt)}</span>}
            </div>
          </div>
        </div>
        {isAdmin && !a.builtin && (
          <div className="flex gap-1 shrink-0">
            <button className="btn btn-ghost !py-1 text-xs" onClick={() => setEditing((e) => !e)} aria-expanded={editing}><Pencil className="h-3.5 w-3.5" /> Edit</button>
            <button className="btn btn-ghost !py-1 text-xs" disabled={busy} onClick={toggle}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />} {active ? "Disconnect" : "Reconnect"}
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Mini label="Received" value={usd(a.received)} />
        <Mini label="Refunded" value={usd(a.refunded)} />
        <Mini label="Gifts" value={String(a.gifts)} href={a.gifts ? `/transactions?account=paypal:${a.id}` : undefined} />
      </div>

      <div>
        <div className="text-xs uppercase tracking-wide text-muted font-semibold mb-1.5">Donation links paying in</div>
        {a.funds.length ? (
          <div className="flex flex-wrap gap-1.5">{a.funds.map((f) => <Link key={f.id} href={`/funds/${f.slug}`} className="rounded-full border border-line px-2.5 py-0.5 text-xs hover:bg-hover">{f.title}</Link>)}</div>
        ) : (
          <p className="text-xs text-muted">{active ? "No fund uses this account yet." : "None while disconnected."}</p>
        )}
      </div>

      {a.mode === "live" && (
        <div className="text-xs text-ink-2">
          <span className="font-semibold text-ink">Webhooks:</span> {a.webhooks ? "signature checked with this account's webhook ID." : "not set up, so refunds and disputes made inside PayPal won't show here."} In the PayPal app, send events to{" "}
          <button
            className="font-mono underline decoration-dotted inline-flex items-center gap-1 break-all text-left"
            onClick={() => { void navigator.clipboard?.writeText(a.webhookUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
            title="Copy"
          >
            {a.webhookUrl} {copied ? <Check className="h-3 w-3 shrink-0" /> : <Copy className="h-3 w-3 shrink-0" />}
          </button>
        </div>
      )}
      {a.builtin && isAdmin && (
        <p className="text-xs text-muted">Set on the server ({a.live ? "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET" : "add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to make it live"}). Funds use it unless you choose another account.</p>
      )}

      {editing && <EditPayPalAccount a={a} onDone={(m) => { setEditing(false); onDone(m); }} />}
    </section>
  );
}

function Mini({ label, value, href }: { label: string; value: string; href?: string }) {
  const body = (
    <>
      <div className="text-xs text-muted">{label}</div>
      <div className="text-base font-semibold tnum">{value}</div>
    </>
  );
  return href ? <Link href={href} className="rounded-lg bg-page px-3 py-2 hover:bg-hover">{body}</Link> : <div className="rounded-lg bg-page px-3 py-2">{body}</div>;
}

function AddPayPalAccount({ onDone }: { onDone: (msg: string) => void }) {
  const [f, setF] = useState({ name: "", email: "", mode: "live" as "live" | "simulated", env: "sandbox" as "sandbox" | "live", clientId: "", clientSecret: "", webhookId: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = f.mode === "live";
  return (
    <form
      className="card p-5 mb-4 border-brand space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await api("/api/paypal/accounts", { json: { action: "create", ...f } });
          onDone(`Added ${f.name}. Choose which funds pay into it under Settings → Funds.`);
        } catch (x) {
          setErr((x as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <h3 className="font-semibold">Add a PayPal account</h3>
        <p className="text-xs text-ink-2">Use a PayPal business account&apos;s REST app keys (developer.paypal.com → Apps &amp; Credentials). The keys are checked with PayPal before they&apos;re saved, and the secret is stored encrypted.</p>
      </div>
      <div className="flex rounded-lg border border-line overflow-hidden text-sm font-semibold w-fit" role="radiogroup" aria-label="Account type">
        {(["live", "simulated"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={f.mode === m} onClick={() => setF({ ...f, mode: m })} className={clsx("px-3 py-1.5", f.mode === m ? "bg-brand-wash text-brand-ink" : "bg-surface text-ink-2")}>
            {m === "live" ? "Connect with API keys" : "Simulated (no keys)"}
          </button>
        ))}
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div><label className="label" htmlFor="pp-name">Account name</label><input id="pp-name" className="input" placeholder="Appeals account" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label className="label" htmlFor="pp-email">PayPal login email (optional)</label><input id="pp-email" type="email" className="input" placeholder="appeals@your-ngo.org" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        {live && (
          <>
            <div>
              <label className="label" htmlFor="pp-env">Environment</label>
              <select id="pp-env" className="input" value={f.env} onChange={(e) => setF({ ...f, env: e.target.value as "sandbox" | "live" })}>
                <option value="sandbox">Sandbox (test money)</option>
                <option value="live">Live (real money)</option>
              </select>
            </div>
            <div><label className="label" htmlFor="pp-wh">Webhook ID (optional)</label><input id="pp-wh" className="input font-mono" value={f.webhookId} onChange={(e) => setF({ ...f, webhookId: e.target.value })} /></div>
            <div><label className="label" htmlFor="pp-id">Client ID</label><input id="pp-id" className="input font-mono" autoComplete="off" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} /></div>
            <div><label className="label" htmlFor="pp-secret">Secret</label><input id="pp-secret" type="password" className="input font-mono" autoComplete="new-password" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} /></div>
          </>
        )}
      </div>
      {!live && <p className="text-xs text-muted">A simulated account moves no money. Donations to its funds are recorded as simulated, for demos and training.</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={busy || !f.name.trim() || (live && (!f.clientId.trim() || !f.clientSecret.trim()))}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} {live ? "Check keys and add" : "Add account"}
        </button>
        {err && <span className="text-sm text-critical" role="alert">{err}</span>}
      </div>
    </form>
  );
}

function EditPayPalAccount({ a, onDone }: { a: PayPalAccount; onDone: (msg: string) => void }) {
  const [f, setF] = useState({ name: a.name, email: a.email ?? "", webhookId: "", clientId: "", clientSecret: "" });
  const [keys, setKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="rounded-xl border border-line p-4 space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await api("/api/paypal/accounts", {
            json: {
              action: "update",
              id: a.id,
              name: f.name,
              email: f.email,
              ...(f.webhookId.trim() ? { webhookId: f.webhookId } : {}),
              ...(keys ? { clientId: f.clientId, clientSecret: f.clientSecret } : {}),
            },
          });
          onDone(`${f.name} saved.`);
        } catch (x) {
          setErr((x as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <div><label className="label" htmlFor={`pe-name-${a.id}`}>Account name</label><input id={`pe-name-${a.id}`} className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label className="label" htmlFor={`pe-email-${a.id}`}>PayPal login email</label><input id={`pe-email-${a.id}`} type="email" className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        {a.mode === "live" && (
          <div className="sm:col-span-2"><label className="label" htmlFor={`pe-wh-${a.id}`}>Webhook ID {a.webhooks && <span className="text-muted font-normal">(set; type a new one to replace it)</span>}</label><input id={`pe-wh-${a.id}`} className="input font-mono" value={f.webhookId} onChange={(e) => setF({ ...f, webhookId: e.target.value })} /></div>
        )}
        {a.mode === "live" && keys && (
          <>
            <div><label className="label" htmlFor={`pe-id-${a.id}`}>New client ID (blank keeps the current one)</label><input id={`pe-id-${a.id}`} className="input font-mono" autoComplete="off" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} /></div>
            <div><label className="label" htmlFor={`pe-sec-${a.id}`}>New secret</label><input id={`pe-sec-${a.id}`} type="password" className="input font-mono" autoComplete="new-password" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} /></div>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary !py-1.5 text-sm" disabled={busy || !f.name.trim() || (keys && !f.clientSecret.trim())}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Save</button>
        {a.mode === "live" && !keys && <button type="button" className="btn btn-ghost !py-1.5 text-sm" onClick={() => setKeys(true)}><KeyRound className="h-4 w-4" /> Replace API keys</button>}
        {err && <span className="text-sm text-critical" role="alert">{err}</span>}
      </div>
    </form>
  );
}
