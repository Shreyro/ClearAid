"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { AlertTriangle, ArrowLeftRight, FileUp, KeyRound, Landmark, Link2, Loader2, PenLine, Plus, RefreshCw, Settings2, Unplug, X } from "lucide-react";
import clsx from "clsx";
import { Page, useMe } from "@/components/AppShell";
import { AnonymisedNote } from "@/components/banking";
import { ago, api, useJson, useLive, usd } from "@/components/hooks";
import { Empty, Pill } from "@/components/ui";
import { PayPalAccounts } from "@/components/PayPalAccounts";
import { openPlaidLink } from "@/components/plaidLink";
import { DataGrid } from "@/components/DataGrid";

type Mapping = { date?: string; description?: string; amount?: string; debit?: string; credit?: string; reference?: string; counterparty?: string; type?: string; dateFormat: "ymd" | "dmy" | "mdy" };
type Account = {
  id: string;
  name: string;
  provider: "csv" | "plaid";
  institution: string;
  mask?: string;
  status: "active" | "disconnected";
  createdAt: string;
  lastSyncAt?: string;
  feePatterns: string[];
  simulated: boolean;
  subAccounts: { name: string; mask?: string }[];
  health: { status: "ok" | "reconnect" | "error"; reason?: string; at: string } | null;
  sameLogin: string[];
  /** PayPal accounts whose withdrawals land here (their deposits are transfers). */
  transfersFrom: { id: string; name: string }[];
  counts: { total: number; untagged: number; fees: number; tagged: number; transfers: number };
  moneyIn: number;
  moneyOut: number;
  imports: { id: string; source: string; fileName?: string; rows: number; imported: number; duplicates: number; autoTagged: number; anonymised: number; errors: string[]; createdAt: string; by: string }[];
};
type Resp = { accounts: Account[]; plaid: { live: boolean; env?: string; oauth?: boolean; webhooks?: boolean; autoSyncMinutes?: number } };

export default function SourcesPage() {
  const { me } = useMe();
  const isAdmin = me.role === "admin";
  const { data, reload } = useJson<Resp>("/api/bank/accounts");
  useLive(undefined, (e) => {
    if (e.kind === "bank") void reload();
  });
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key);
    setMsg(null);
    try {
      const m = await fn();
      if (m) setMsg({ text: m });
      await reload();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(null);
    }
  }

  async function connectPlaid() {
    await run("plaid", async () => (await openPlaidLink({ mode: "new" })) ?? undefined);
  }
  const connected = data?.accounts.filter((a) => a.provider === "plaid" && a.status === "active") ?? [];
  const needLogin = connected.filter((a) => a.health?.status === "reconnect");

  return (
    <Page
      title="Sources"
      subtitle="Where transaction data comes from: your PayPal accounts, your bank accounts (CSV statement upload or a live Plaid connection; connect as many as you have) and money recorded by staff. Every bank line is read for a tracking code (e.g. #RO1) and traced to that fund; the rest wait in Untagged. Names of private individuals, account numbers, phone numbers and emails in bank lines are anonymised before they are stored."
      actions={
        isAdmin ? (
          <>
            {connected.length > 0 && (
              <button className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => run("syncall", async () => (await api<{ message: string }>("/api/bank/plaid", { json: { action: "sync_all" } })).message)}>
                {busy === "syncall" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Sync all banks
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => setAdding((a) => !a)}>{adding ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />} Bank account (CSV)</button>
            {data?.plaid.live ? (
              <button className="btn btn-primary" onClick={connectPlaid} disabled={Boolean(busy)}>{busy === "plaid" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Connect with Plaid</button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={Boolean(busy)}
                title="No Plaid keys are configured, so this adds a simulated bank feed"
                onClick={() => run("sim", async () => { await api("/api/bank/plaid", { json: { action: "connect_simulated" } }); return "Simulated bank connected. Press Sync to pull transactions."; })}
              >
                {busy === "sim" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Connect bank (simulated)
              </button>
            )}
          </>
        ) : undefined
      }
    >
      {adding && <AddCsvAccount onDone={(m) => { setAdding(false); setMsg({ text: m }); void reload(); }} />}
      {msg && <div role="status" className={clsx("card p-3 text-sm mb-4", msg.bad ? "bg-bad-wash border-bad-line text-bad-ink" : "bg-brand-wash border-brand-line")}>{msg.text}</div>}
      {needLogin.length > 0 && (
        <div role="alert" className="card p-3 text-sm mb-4 bg-warn-wash border-warn-line flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-warn-ink" />
          <span>{[...new Set(needLogin.map((a) => a.institution))].join(", ")} need{needLogin.length === 1 ? "s" : ""} someone to log in to the bank again before more transactions can arrive.{isAdmin ? " Press “Log in again” on the account." : " Ask an admin."}</span>
        </div>
      )}
      {data?.plaid.live && (
        <p className="text-xs text-muted mb-4">
          Plaid ({data.plaid.env ?? "sandbox"}): new transactions arrive {data.plaid.webhooks ? "as soon as Plaid has them" : "when someone syncs"}{data.plaid.autoSyncMinutes ? `, and every connected bank is checked every ${data.plaid.autoSyncMinutes} min` : ""}.
          {isAdmin && !data.plaid.oauth && " Banks that log in on their own website (e.g. Chase) need PLAID_REDIRECT_URI set on the backend."}
        </p>
      )}
      {data && !data.plaid.live && isAdmin && (
        <p className="text-xs text-muted mb-4">Plaid isn&apos;t configured (set <span className="font-mono">PLAID_CLIENT_ID</span> and <span className="font-mono">PLAID_SECRET</span> on the backend for sandbox). Until then, &ldquo;Connect bank&rdquo; adds a simulated feed.</p>
      )}

      <PayPalAccounts isAdmin={isAdmin} />

      <h2 className="text-lg font-semibold mt-10 mb-3">Bank accounts {data && <span className="text-muted font-normal text-base">({data.accounts.length})</span>}</h2>
      {!data ? (
        <div className="card p-6"><Loader2 className="h-5 w-5 animate-spin text-muted" /></div>
      ) : data.accounts.length === 0 ? (
        <div className="card"><Empty>No bank accounts yet. {isAdmin ? "Add a CSV account or connect a bank." : "Ask an admin to add one."}</Empty></div>
      ) : (
        <div className="space-y-4">
          {data.accounts.map((a) => (
            <AccountCard key={a.id} a={a} isAdmin={isAdmin} busy={busy} run={run} />
          ))}
        </div>
      )}

      <h2 className="text-lg font-semibold mt-10 mb-3">Other money in</h2>
      <OtherSources />
    </Page>
  );
}

type FlowGraph = { nodes: { id: string; label: string }[]; links: { source: string; target: string; value: number }[] };

/** Staff-recorded money: totals read from the same flow the Money flow page draws. */
function OtherSources() {
  const { data } = useJson<{ flow: { category: FlowGraph } }>("/api/overview");
  const total = (id: string) => data?.flow.category.links.filter((l) => l.source === id).reduce((a, l) => a + l.value, 0) ?? 0;
  const funds = (id: string) => new Set(data?.flow.category.links.filter((l) => l.source === id).map((l) => l.target)).size;
  const cards = [
    {
      id: "src:manual",
      icon: <PenLine className="h-5 w-5" />,
      name: "Recorded by staff",
      pill: <Pill>Manual</Pill>,
      text: "Cheques, cash and grants received outside PayPal or a connected bank, recorded with a reference under the staff member's name.",
      href: "/transactions?direction=in&q=Recorded",
    },
  ];
  return (
    <div className="grid md:grid-cols-2 gap-4">
      {cards.map((c) => (
        <section key={c.id} className="card p-5 flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-xl bg-info-wash text-paypal grid place-items-center shrink-0">{c.icon}</div>
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold flex flex-wrap items-center gap-2">{c.name} {c.pill}</h2>
              <p className="text-xs text-ink-2 mt-0.5">{c.text}</p>
            </div>
          </div>
          <div className="flex items-end justify-between gap-3 mt-auto">
            <div>
              <div className="text-xl font-semibold tnum">{data ? usd(total(c.id)) : "—"}</div>
              <div className="text-xs text-muted">{data ? `into ${funds(c.id)} fund${funds(c.id) === 1 ? "" : "s"}` : ""}</div>
            </div>
            <Link href={c.href} className="text-xs text-ink-2 hover:text-ink">See transactions →</Link>
          </div>
        </section>
      ))}
    </div>
  );
}

/** Admins: choose the PayPal accounts whose balance is withdrawn into this bank account. */
function PayPalLink({ a, onDone }: { a: Account; onDone: (message: string) => void }) {
  const { data } = useJson<{ accounts: { id: string; name: string; status: string }[] }>("/api/paypal/accounts");
  const [picked, setPicked] = useState<Set<string>>(new Set(a.transfersFrom.map((p) => p.id)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const options = data?.accounts.filter((p) => p.status !== "pending") ?? [];
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ message?: string }>("/api/bank/accounts", { json: { action: "update", id: a.id, transfersFrom: [...picked] } });
      onDone(r.message ?? "Saved.");
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 rounded-xl border border-line p-3 space-y-2">
      <p className="text-sm">Which PayPal accounts withdraw their balance into <span className="font-medium">{a.name}</span>? Deposits from them that read like a PayPal transfer are kept off every fund, because ClearAid already counted that money when the gifts came in.</p>
      {!data ? <Loader2 className="h-4 w-4 animate-spin text-muted" /> : (
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {options.map((p) => (
            <label key={p.id} className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={picked.has(p.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
              {p.name}
            </label>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-primary !py-1.5 text-sm" disabled={busy || !data} onClick={save}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Save link</button>
        {err && <span className="text-xs text-critical">{err}</span>}
      </div>
    </div>
  );
}

function AccountCard({ a, isAdmin, busy, run }: { a: Account; isAdmin: boolean; busy: string | null; run: (key: string, fn: () => Promise<string | void>) => Promise<void> }) {
  const [uploading, setUploading] = useState(false);
  const [fees, setFees] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const active = a.status === "active";
  return (
    <section className={clsx("card p-5", !active && "opacity-70")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-brand-wash text-brand grid place-items-center shrink-0"><Landmark className="h-5 w-5" /></div>
          <div className="min-w-0">
            <h2 className="font-semibold truncate">{a.name}</h2>
            <div className="text-xs text-muted flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
              <span>{a.institution}</span>
              {a.provider === "csv" ? <Pill>CSV upload</Pill> : a.simulated ? <Pill tone="warn">Simulated feed</Pill> : <Pill tone="info">Plaid</Pill>}
              {!active && <Pill tone="bad">Disconnected</Pill>}
              {active && a.health?.status === "reconnect" && <Pill tone="warn">Log in again</Pill>}
              {active && a.health?.status === "error" && <Pill tone="bad">Sync error</Pill>}
              <span>{a.lastSyncAt ? `Last ${a.provider === "csv" ? "upload" : "sync"} ${ago(a.lastSyncAt)}` : "Nothing imported yet"}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {active && a.provider === "csv" && (
            <button className="btn btn-primary !py-1.5 text-sm" onClick={() => setUploading((u) => !u)}>{uploading ? <X className="h-4 w-4" /> : <FileUp className="h-4 w-4" />} Upload statement</button>
          )}
          {active && a.provider === "plaid" && (
            <button
              className="btn btn-primary !py-1.5 text-sm"
              disabled={Boolean(busy)}
              onClick={() => run(`sync:${a.id}`, async () => (await api<{ message: string }>(`/api/bank/accounts/${a.id}/sync`, { method: "POST" })).message)}
            >
              {busy === `sync:${a.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Sync now
            </button>
          )}
          {isAdmin && active && a.provider === "plaid" && !a.simulated && (
            <button
              className={clsx("btn !py-1.5 text-sm", a.health?.status === "reconnect" ? "btn-primary" : "btn-ghost")}
              disabled={Boolean(busy)}
              title="Log in to this bank again through Plaid (when its login has expired, or to share more accounts). Its history is kept."
              onClick={() => run(`relink:${a.id}`, async () => (await openPlaidLink({ mode: "update", accountId: a.id })) ?? undefined)}
            >
              {busy === `relink:${a.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />} Log in again
            </button>
          )}
          {isAdmin && active && (
            <button className="btn btn-ghost !py-1.5 text-sm" onClick={() => setLinking((l) => !l)} aria-expanded={linking} title="Which PayPal accounts withdraw their balance into this bank account">
              <ArrowLeftRight className="h-4 w-4" /> PayPal link
            </button>
          )}
          {isAdmin && (
            <button className="btn btn-ghost !py-1.5 text-sm" onClick={() => setFees((f) => (f === null ? a.feePatterns.join(", ") : null))}><Settings2 className="h-4 w-4" /> Fee rules</button>
          )}
          {isAdmin && (
            <button
              className="btn btn-ghost !py-1.5 text-sm"
              disabled={Boolean(busy)}
              onClick={() => run(`dc:${a.id}`, async () => { await api("/api/bank/accounts", { json: { action: active ? "disconnect" : "reconnect", id: a.id } }); return active ? `${a.name} disconnected. Its imported transactions are kept.` : `${a.name} reconnected.`; })}
            >
              <Unplug className="h-4 w-4" /> {active ? "Disconnect" : "Reconnect"}
            </button>
          )}
        </div>
      </div>

      {active && a.health && a.health.status !== "ok" && a.health.reason && <p className={clsx("text-xs mt-3", a.health.status === "reconnect" ? "text-warn-ink" : "text-critical")}>{a.health.reason}</p>}
      {a.sameLogin.length > 0 && <p className="text-xs text-muted mt-2">Same bank login as {a.sameLogin.join(", ")}: they sync together.</p>}
      <p className="text-xs text-ink-2 mt-2 flex items-center gap-1.5">
        <ArrowLeftRight className="h-3.5 w-3.5 text-muted" aria-hidden />
        {a.transfersFrom.length ? (
          <span>Receives withdrawals from {a.transfersFrom.map((p) => p.name).join(", ")}: {a.counts.transfers} transfer{a.counts.transfers === 1 ? "" : "s"} so far, never counted as new money{a.counts.transfers ? <> (<Link className="underline" href={`/untagged?status=transfers&account=${a.id}`}>see them</Link>)</> : null}.</span>
        ) : (
          <span>Not linked to a PayPal account{a.counts.transfers ? ` (${a.counts.transfers} line${a.counts.transfers === 1 ? "" : "s"} marked as transfers by hand)` : ""}.</span>
        )}
      </p>
      {linking && <PayPalLink a={a} onDone={(m) => { setLinking(false); void run(`link:${a.id}`, async () => m); }} />}

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-4">
        <Mini label="Money in" value={usd(a.moneyIn)} tone="text-good-ink" />
        <Mini label="Money out" value={usd(a.moneyOut)} tone="text-out-ink" />
        <Mini label="Tagged to funds" value={String(a.counts.tagged)} href={`/untagged?status=tagged&account=${a.id}`} />
        <Mini label="Need a tag" value={String(a.counts.untagged)} tone={a.counts.untagged ? "text-warn-ink" : undefined} href={`/untagged?status=untagged&account=${a.id}`} />
        <Mini label="Unallocated fees" value={String(a.counts.fees)} href={`/untagged?status=fees&account=${a.id}`} />
      </div>

      {fees !== null && (
        <form
          className="mt-4 rounded-xl border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(`fees:${a.id}`, async () => { await api("/api/bank/accounts", { json: { action: "update", id: a.id, feePatterns: fees.split(",").map((s) => s.trim()).filter(Boolean) } }); setFees(null); return "Fee rules saved. They apply to transactions imported from now on."; });
          }}
        >
          <label className="label" htmlFor={`fees-${a.id}`}>Bank-fee description patterns (comma separated)</label>
          <div className="flex gap-2">
            <input id={`fees-${a.id}`} className="input font-mono text-sm" value={fees} onChange={(e) => setFees(e.target.value)} placeholder="SERVICE CHARGE, SWIFT CHG" />
            <button className="btn btn-primary" disabled={Boolean(busy)}>Save</button>
          </div>
          <p className="text-xs text-muted mt-1">Charges matching these, or the bank&apos;s own fee type codes (SRVCHG, FEE, NCHG, BANK_FEES), stay in the general fund unless they carry a tracking code. Staff can still tag them by hand.</p>
        </form>
      )}

      {uploading && <Uploader account={a} onDone={(m) => { setUploading(false); void run("noop", async () => m); }} />}

      {a.imports.length > 0 && (
        <details className="mt-4">
          <summary className="text-xs font-semibold text-ink-2 cursor-pointer">Import history ({a.imports.length})</summary>
          <ul className="mt-2 divide-y divide-line text-xs">
            {a.imports.map((i) => (
              <li key={i.id} className="py-2 flex flex-wrap gap-x-3 gap-y-1">
                <span className="font-medium">{i.source === "csv" ? i.fileName : "Bank sync"}</span>
                <span className="text-muted">{new Date(i.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {i.by}</span>
                <span>{i.imported} new · {i.autoTagged} tagged by code · {i.duplicates} already imported{i.anonymised > 0 ? ` · ${i.anonymised} anonymised` : ""}</span>
                {i.errors.length > 0 && <span className="text-critical" title={i.errors.join("\n")}>{i.errors.length} unreadable row(s)</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Mini({ label, value, tone, href }: { label: string; value: string; tone?: string; href?: string }) {
  const body = (
    <>
      <div className="text-xs text-muted">{label}</div>
      <div className={clsx("text-base font-semibold tnum", tone)}>{value}</div>
    </>
  );
  return href ? <Link href={href} className="rounded-lg bg-page px-3 py-2 hover:bg-hover">{body}</Link> : <div className="rounded-lg bg-page px-3 py-2">{body}</div>;
}

function AddCsvAccount({ onDone }: { onDone: (msg: string) => void }) {
  const [f, setF] = useState({ name: "", institution: "", mask: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="card p-5 mb-4 border-brand grid sm:grid-cols-4 gap-3 items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await api("/api/bank/accounts", { json: { action: "create_csv", ...f } });
          onDone(`Added ${f.name}. Upload a CSV statement to bring in its transactions.`);
        } catch (x) {
          setErr((x as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="sm:col-span-4"><h2 className="font-semibold">Add an account for CSV statements</h2><p className="text-xs text-ink-2">For banks without a Plaid connection: download the statement as CSV from online banking and upload it here.</p></div>
      <div><label className="label" htmlFor="ba-name">Account name</label><input id="ba-name" className="input" placeholder="Relief collections account" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
      <div><label className="label" htmlFor="ba-inst">Bank</label><input id="ba-inst" className="input" placeholder="Bank name" value={f.institution} onChange={(e) => setF({ ...f, institution: e.target.value })} /></div>
      <div><label className="label" htmlFor="ba-mask">Last 4 digits</label><input id="ba-mask" className="input font-mono" inputMode="numeric" maxLength={4} value={f.mask} onChange={(e) => setF({ ...f, mask: e.target.value.replace(/\D/g, "") })} /></div>
      <div className="flex items-center gap-3"><button className="btn btn-primary" disabled={busy || !f.name.trim()}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Add account</button>{err && <span className="text-sm text-critical" role="alert">{err}</span>}</div>
    </form>
  );
}

type Preview = {
  header: string[];
  mapping: Mapping;
  missing: string[];
  sample: string[][];
  /** Rows as they will be stored, with personal details already replaced. */
  parsed: { date: string; amount: number; description: string; reference?: string; anonymised: string[] }[];
  /** How many readable rows have something replaced. */
  anonymised: number;
  rowCount: number;
  validCount: number;
  errors: string[];
  totals: { in: number; out: number };
};

const FIELDS: { key: keyof Omit<Mapping, "dateFormat">; label: string; required?: boolean }[] = [
  { key: "date", label: "Date", required: true },
  { key: "description", label: "Description", required: true },
  { key: "amount", label: "Amount (signed)" },
  { key: "debit", label: "Debit / money out" },
  { key: "credit", label: "Credit / money in" },
  { key: "reference", label: "Reference / txn ID" },
  { key: "counterparty", label: "Payee / payer" },
  { key: "type", label: "Type code" },
];

function Uploader({ account, onDone }: { account: Account; onDone: (msg: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function check(f: { name: string; content: string }, m?: Mapping) {
    setBusy(true);
    setErr(null);
    try {
      const p = await api<Preview>(`/api/bank/accounts/${account.id}/import`, { json: { fileName: f.name, content: f.content, preview: true, mapping: m } });
      setPreview(p);
      setMapping(p.mapping);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!file || !mapping) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ message: string }>(`/api/bank/accounts/${account.id}/import`, { json: { fileName: file.name, content: file.content, mapping } });
      onDone(r.message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const setField = (k: keyof Mapping, v: string) => {
    if (!mapping || !file) return;
    const next = { ...mapping, [k]: v || undefined } as Mapping;
    if (k === "amount" && v) next.debit = next.credit = undefined;
    if ((k === "debit" || k === "credit") && v) next.amount = undefined;
    setMapping(next);
    void check(file, next);
  };

  return (
    <div className="mt-4 rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="text-sm file:btn file:btn-ghost file:mr-3"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 5 * 1024 * 1024) return setErr("Statements up to 5 MB, please. Split larger files by month.");
            const next = { name: f.name, content: await f.text() };
            setFile(next);
            setPreview(null);
            void check(next);
          }}
        />
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
      </div>
      <p className="text-xs text-muted mt-1">CSV with a header row. Columns are detected automatically and the mapping is remembered for this account. Rows already imported are skipped, and the same file can&apos;t be imported twice.</p>
      {err && <p className="text-sm text-critical mt-2" role="alert">{err}</p>}

      {preview && mapping && (
        <div className="mt-4 space-y-4">
          <div>
            <h3 className="text-sm font-semibold mb-2">Columns</h3>
            <div className="grid sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {FIELDS.map((fd) => (
                <div key={fd.key}>
                  <label className="label" htmlFor={`map-${fd.key}`}>{fd.label}{fd.required && " *"}</label>
                  <select id={`map-${fd.key}`} className="input !py-1.5 text-sm" value={mapping[fd.key] ?? ""} onChange={(e) => setField(fd.key, e.target.value)}>
                    <option value="">—</option>
                    {preview.header.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
              <div>
                <label className="label" htmlFor="map-df">Date format</label>
                <select id="map-df" className="input !py-1.5 text-sm" value={mapping.dateFormat} onChange={(e) => setField("dateFormat", e.target.value)}>
                  <option value="dmy">DD/MM/YYYY</option>
                  <option value="mdy">MM/DD/YYYY</option>
                  <option value="ymd">YYYY-MM-DD</option>
                </select>
              </div>
            </div>
            {preview.missing.length > 0 && <p className="text-sm text-warn-ink mt-2">Choose a column for: {preview.missing.join(", ")}.</p>}
          </div>

          {preview.missing.length === 0 && (
            <>
              <div className="text-sm">
                <strong>{preview.validCount}</strong> of {preview.rowCount} rows readable · <span className="text-good-ink">{usd(preview.totals.in)} in</span> · <span className="text-out-ink">{usd(preview.totals.out)} out</span>
                {preview.errors.length > 0 && (
                  <details className="mt-1 text-xs text-critical">
                    <summary className="cursor-pointer">{preview.errors.length} row(s) will be skipped</summary>
                    <ul className="list-disc pl-5 mt-1">{preview.errors.map((e) => <li key={e}>{e}</li>)}</ul>
                  </details>
                )}
                <p className="text-xs text-ink-2 mt-1">
                  {preview.anonymised > 0
                    ? `Personal details will be anonymised on ${preview.anonymised} row${preview.anonymised === 1 ? "" : "s"}: a person's name becomes a stable alias, and account numbers, phone numbers and emails are redacted. The rows below are shown as they will be stored.`
                    : "No personal details were found to anonymise in this file."}
                </p>
              </div>
              <div className="overflow-x-auto">
                <DataGrid
                  rows={preview.parsed}
                  minWidth={560}
                  inCard={false}
                  ariaLabel="Statement lines found"
                  cols={[
                    { header: "Date", width: 115, value: (r) => r.date },
                    { header: "Amount", width: 120, align: "right", value: (r) => r.amount, render: (r) => <span className={clsx("font-semibold", r.amount < 0 ? "text-out-ink" : "text-good-ink")}>{r.amount < 0 ? "−" : "+"}{usd(Math.abs(r.amount))}</span> },
                    { header: "Description", flex: 1, minWidth: 220, wrap: true, value: (r) => r.description, render: (r) => <span>{r.description}{r.anonymised.length > 0 && <span className="ml-2"><AnonymisedNote kinds={r.anonymised} short /></span>}</span> },
                    { header: "Reference", width: 160, value: (r) => r.reference, render: (r) => <span className="font-mono">{r.reference}</span> },
                  ]}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button className="btn btn-primary" onClick={doImport} disabled={busy || preview.validCount === 0}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Import {preview.validCount} rows</button>
                <button className="btn btn-ghost" onClick={() => { setFile(null); setPreview(null); if (fileRef.current) fileRef.current.value = ""; }}>Choose another file</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
