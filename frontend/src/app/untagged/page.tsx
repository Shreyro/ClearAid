"use client";

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { Check, Clock, FileText, History, Loader2, Paperclip, Plus, Receipt, Tag, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { Page, useMe } from "@/components/AppShell";
import { CodeChip, SUBCODE_HINT } from "@/components/banking";
import { api, useJson, useLive, usd } from "@/components/hooks";
import { CAT_LABEL } from "@/components/SpendCard";
import { Empty, Pill } from "@/components/ui";

type Alloc = { fundId: string; fundTitle: string; amount: number; category?: string; code?: string };
type Txn = {
  id: string;
  accountId: string;
  accountName: string;
  provider: string;
  date: string;
  amount: number;
  description: string;
  counterparty?: string;
  reference?: string;
  isFee: boolean;
  status: "auto_tagged" | "tagged" | "untagged" | "fee_unallocated";
  untaggedReason?: string;
  allocations: Alloc[];
  tagSource?: "code" | "manual" | "fee_policy";
  taggedByName?: string;
  taggedAt?: string;
  reason?: string;
  approvedByName?: string;
  pending?: { kind: "tag" | "retag" | "untag"; allocations: Alloc[]; reason: string; byName: string; at: string; why: string; mine: boolean; canApprove: boolean };
  receipts: ReceiptRec[];
  missingReceipt: boolean;
  history: { allocations: { fundId: string; amount: number; category?: string }[]; by: string; at: string; reason?: string }[];
  ageDays: number;
};
type ReceiptRec = {
  fileId: string;
  fileName: string;
  url: string;
  engine: "claude" | "none";
  extraction?: { supplier: string | null; invoiceNumber: string | null; date: string | null; currency: string | null; total: number | null; printedCode: string | null; legible: boolean };
  match: { score: number; signals: string[] };
  codeMismatch?: string;
  note?: string;
  byName: string;
  at: string;
};
type FundOpt = { id: string; title: string; status: string; codes: string[]; canTag: boolean };
type Resp = {
  transactions: Txn[];
  counts: Record<(typeof TABS)[number][0], number>;
  funds: FundOpt[];
  accounts: { id: string; name: string }[];
  controls: { tagApprovalThreshold: number; receiptThreshold: number };
};

const TABS = [
  ["untagged", "Needs a tag"],
  ["pending", "Waiting for approval"],
  ["receipts", "Missing receipts"],
  ["fees", "Bank fees"],
  ["tagged", "Tagged"],
  ["all", "All"],
] as const;
const CATS = Object.keys(CAT_LABEL);

const STATUS: Record<Txn["status"], { label: string; tone: "good" | "warn" | "neutral" | "brand" }> = {
  auto_tagged: { label: "Tagged by code", tone: "good" },
  tagged: { label: "Tagged by hand", tone: "brand" },
  untagged: { label: "Needs a tag", tone: "warn" },
  fee_unallocated: { label: "Fee · general fund", tone: "neutral" },
};

export default function UntaggedPage() {
  const { me } = useMe();
  const [status, setStatus] = useState<string>("untagged");
  const [account, setAccount] = useState("");
  const [fund, setFund] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);

  // Deep links from Sources (?status=…&account=…) and Transactions (?status=all&q=<bank line id>).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    /* eslint-disable react-hooks/set-state-in-effect */
    if (p.get("status")) setStatus(p.get("status")!);
    if (p.get("account")) setAccount(p.get("account")!);
    if (p.get("q")) setQ(p.get("q")!);
    if (p.get("q")?.startsWith("btx_")) setOpen(p.get("q")!);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const params = new URLSearchParams({ status });
  if (account) params.set("account", account);
  if (fund) params.set("fund", fund);
  if (q.trim()) params.set("q", q.trim());
  const { data, reload } = useJson<Resp>(`/api/bank/transactions?${params}`);
  useLive(undefined, (e) => {
    if (e.kind === "bank") void reload();
  });

  const done = async (m: string) => {
    setMsg(m);
    setOpen(null);
    setSelected(new Set());
    await reload();
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const rows = data?.transactions ?? [];
  const taggable = data?.funds.filter((f) => f.canTag) ?? [];

  return (
    <Page
      wide
      title="Untagged"
      subtitle={
        <>
          Bank money whose fund can&apos;t be traced yet. Lines are matched to a fund by the tracking code in their description (e.g. <span className="font-mono">#RO1</span> or <span className="font-mono">#ASHA-MED</span>); lines with no code, an unknown code, or codes for two funds wait here until someone tags or splits them, with a reason. Nothing is guessed by AI.
        </>
      }
      actions={<Link href="/sources" className="btn btn-ghost">Sources</Link>}
    >
      <div className="flex flex-wrap items-end gap-2 mb-3">
        <div className="flex rounded-lg border border-line overflow-hidden text-xs font-semibold" role="tablist">
          {TABS.map(([k, l]) => (
            <button
              key={k}
              role="tab"
              aria-selected={status === k}
              onClick={() => {
                setStatus(k);
                setSelected(new Set());
                setOpen(null);
              }}
              className={clsx("px-3 py-2 inline-flex items-center gap-1.5", status === k ? "bg-brand-wash text-brand-ink" : "bg-surface text-ink-2")}
            >
              {l}
              {data && <span className={clsx("rounded-full px-1.5 tnum", (k === "untagged" || k === "pending" || k === "receipts") && data.counts[k] ? "bg-[#fff4d6] text-[#7a5200]" : "bg-[#efeee9]")}>{data.counts[k]}</span>}
            </button>
          ))}
        </div>
        <div>
          <label className="label" htmlFor="bt-acc">Account</label>
          <select id="bt-acc" className="input !py-1.5 text-sm" value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">All accounts</option>
            {data?.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        {status !== "untagged" && status !== "fees" && status !== "receipts" && (
          <div>
            <label className="label" htmlFor="bt-fund">Fund</label>
            <select id="bt-fund" className="input !py-1.5 text-sm" value={fund} onChange={(e) => setFund(e.target.value)}>
              <option value="">All funds</option>
              {data?.funds.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
            </select>
          </div>
        )}
        <div className="flex-1 min-w-[12rem]">
          <label className="label" htmlFor="bt-q">Search</label>
          <input id="bt-q" className="input !py-1.5 text-sm" placeholder="Description, payee or reference" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {data && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2 mb-3">
          <span className="font-semibold">Fund codes:</span>
          {data.funds.filter((f) => f.status !== "closed").map((f) => (
            <span key={f.id} className="inline-flex items-center gap-1">{f.codes.map((c) => <CodeChip key={c} code={c} />)}<span className="text-muted">{f.title}</span></span>
          ))}
          <span className="text-muted">Category suffixes: {SUBCODE_HINT.map(([c]) => `-${c}`).join(" ")}</span>
          <span className="text-muted">
            A second person signs off manual tags of {usd(data.controls.tagApprovalThreshold)} or more, and every retag. Payments of {usd(data.controls.receiptThreshold)} or more need a receipt.
          </span>
        </div>
      )}

      {msg && (
        <div role="status" className="card p-3 text-sm mb-3 bg-brand-wash border-[#bfe3dc] flex items-start justify-between gap-3">
          {msg}
          <button onClick={() => setMsg(null)} aria-label="Dismiss"><X className="h-4 w-4" /></button>
        </div>
      )}

      {selected.size > 0 && <BulkBar ids={[...selected]} funds={taggable} onDone={done} onClear={() => setSelected(new Set())} />}

      <div className="card overflow-x-auto">
        {!data ? (
          <div className="p-6"><Loader2 className="h-5 w-5 animate-spin text-muted" /></div>
        ) : rows.length === 0 ? (
          <Empty>{status === "untagged" ? "Nothing waiting. Every bank line has a fund." : status === "pending" ? "No tags are waiting for a second person." : status === "receipts" ? "Every payment above the threshold has a receipt." : "No transactions here."}</Empty>
        ) : (
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr className="text-left text-xs text-muted border-b border-line">
                <th className="pl-4 py-2.5 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                  />
                </th>
                <th className="px-3 py-2.5 font-medium">Date</th>
                <th className="px-3 py-2.5 font-medium">Description</th>
                <th className="px-3 py-2.5 font-medium text-right">Amount</th>
                <th className="px-3 py-2.5 font-medium">Fund</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <Fragment key={t.id}>
                  <tr className={clsx("border-b border-line align-top", open === t.id && "bg-[#fafaf7]")}>
                    <td className="pl-4 py-3"><input type="checkbox" aria-label={`Select ${t.description}`} checked={selected.has(t.id)} onChange={() => toggle(t.id)} /></td>
                    <td className="px-3 py-3 tnum whitespace-nowrap">{new Date(`${t.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}<div className="text-[11px] text-muted truncate max-w-[10rem]" title={t.accountName}>{t.accountName}</div></td>
                    <td className="px-3 py-3 max-w-[28rem]">
                      <div className="font-medium break-words">{t.description}</div>
                      <div className="text-[11px] text-muted">
                        {[t.counterparty, t.reference && <span key="r" className="font-mono">{t.reference}</span>].filter(Boolean).map((x, i) => <Fragment key={i}>{i > 0 && " · "}{x}</Fragment>)}
                      </div>
                      {t.untaggedReason && t.status !== "auto_tagged" && t.status !== "tagged" && <div className="text-[11px] text-[#7a5200] mt-0.5">{t.untaggedReason}{t.status === "untagged" && t.ageDays > 7 ? ` · waiting ${t.ageDays} days` : ""}</div>}
                      {t.status === "tagged" && t.reason && <div className="text-[11px] text-ink-2 mt-0.5">“{t.reason}” · {t.taggedByName}{t.approvedByName ? `, approved by ${t.approvedByName}` : ""}</div>}
                      {t.tagSource === "fee_policy" && t.reason && <div className="text-[11px] text-ink-2 mt-0.5">{t.reason}</div>}
                      {t.pending && (
                        <div className="text-[11px] text-[#7a5200] mt-0.5 flex items-center gap-1">
                          <Clock className="h-3 w-3" /> {t.pending.byName} wants to {t.pending.kind} this: {t.pending.allocations.map((a) => a.fundTitle).join(", ") || "back to the queue"}
                        </div>
                      )}
                      {(t.receipts.length > 0 || t.missingReceipt) && (
                        <div className={clsx("text-[11px] mt-0.5 flex items-center gap-1", t.missingReceipt ? "text-[#7a5200]" : "text-ink-2")}>
                          <Receipt className="h-3 w-3" /> {t.receipts.length ? `${t.receipts.length} receipt${t.receipts.length > 1 ? "s" : ""}` : "Receipt needed"}
                          {t.receipts.some((r) => r.codeMismatch) && <span className="text-critical"> · code on receipt differs</span>}
                        </div>
                      )}
                    </td>
                    <td className={clsx("px-3 py-3 text-right tnum font-semibold whitespace-nowrap", t.amount < 0 ? "text-[#9b3d17]" : "text-good-ink")}>{t.amount < 0 ? "−" : "+"}{usd(Math.abs(t.amount))}</td>
                    <td className="px-3 py-3">
                      {t.allocations.length ? (
                        <ul className="space-y-0.5">
                          {t.allocations.map((a, i) => (
                            <li key={i} className="text-xs">
                              <span className="font-medium">{a.fundTitle}</span>
                              {t.allocations.length > 1 && <span className="tnum text-muted"> · {usd(a.amount)}</span>}
                              {a.category && <span className="text-muted"> · {CAT_LABEL[a.category]}</span>}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-xs text-muted">{t.isFee ? "General fund" : "—"}</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {t.pending ? <Pill tone="warn">Waiting for approval</Pill> : t.tagSource === "fee_policy" ? <Pill tone="neutral">Fee policy</Pill> : <Pill tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Pill>}
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      <button className={clsx("btn !py-1 text-xs", t.pending?.canApprove || (!t.allocations.length && !t.pending) ? "btn-primary" : "btn-ghost")} onClick={() => setOpen(open === t.id ? null : t.id)}>
                        {open === t.id ? <X className="h-3.5 w-3.5" /> : t.pending ? <Clock className="h-3.5 w-3.5" /> : <Tag className="h-3.5 w-3.5" />} {t.pending ? (t.pending.canApprove ? "Review" : "Pending") : t.allocations.length ? "Details" : "Tag"}
                      </button>
                    </td>
                  </tr>
                  {open === t.id && (
                    <tr className="border-b border-line bg-[#fafaf7]">
                      <td colSpan={7} className="px-4 pb-4">
                        {t.pending ? <PendingPanel t={t} onDone={done} /> : <TagPanel t={t} funds={data.funds} isAdmin={me.role === "admin"} threshold={data.controls.tagApprovalThreshold} onDone={done} />}
                        <ReceiptsPanel
                          t={t}
                          onChanged={async (m) => {
                            setMsg(m);
                            await reload();
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  );
}

type Row = { fundId: string; category: string; amount: string };

function TagPanel({ t, funds, isAdmin, threshold, onDone }: { t: Txn; funds: FundOpt[]; isAdmin: boolean; threshold: number; onDone: (m: string) => Promise<void> }) {
  const total = Math.abs(t.amount);
  const taggable = funds.filter((f) => f.canTag);
  const [rows, setRows] = useState<Row[]>(
    t.allocations.length
      ? t.allocations.map((a) => ({ fundId: a.fundId, category: a.category ?? "", amount: (a.amount / 100).toFixed(2) }))
      : [{ fundId: "", category: "", amount: (total / 100).toFixed(2) }],
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sum = rows.reduce((s, r) => s + Math.round(Number(r.amount || 0) * 100), 0);
  const left = total - sum;
  const blocked = t.allocations.some((a) => !funds.find((f) => f.id === a.fundId)?.canTag);

  async function save(allocations: Row[]) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ message: string }>("/api/bank/transactions", {
        json: { action: "tag", id: t.id, reason, allocations: allocations.map((x) => ({ fundId: x.fundId, category: x.category || undefined, amountUsd: Number(x.amount) })) },
      });
      await onDone(r.message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  if (blocked && !isAdmin) {
    return <p className="text-sm text-ink-2 pt-3">This line is tagged to a fund you&apos;re not assigned to, so only an admin or that fund&apos;s approvers can change it.</p>;
  }
  if (!taggable.length) {
    return <p className="text-sm text-ink-2 pt-3">You aren&apos;t assigned to any open fund yet, so you can&apos;t tag money to one. Ask to join a fund on Funds &amp; access.</p>;
  }

  return (
    <form
      className="pt-3 grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save(rows);
      }}
    >
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_10rem_8rem_2rem] gap-2 items-center">
            <select aria-label="Fund" className="input !py-1.5 text-sm" value={r.fundId} onChange={(e) => set(i, { fundId: e.target.value })} required>
              <option value="">Choose a fund…</option>
              {taggable.map((f) => <option key={f.id} value={f.id}>{f.title} ({f.codes.map((c) => `#${c}`).join(" ")})</option>)}
            </select>
            <select aria-label="Budget category" className="input !py-1.5 text-sm" value={r.category} onChange={(e) => set(i, { category: e.target.value })}>
              <option value="">No category</option>
              {CATS.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
            </select>
            <input aria-label="Amount (USD)" className="input !py-1.5 text-sm tnum text-right" type="number" step="0.01" min="0.01" value={r.amount} onChange={(e) => set(i, { amount: e.target.value })} required />
            {rows.length > 1 ? (
              <button type="button" className="text-muted hover:text-critical" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove split"><Trash2 className="h-4 w-4" /></button>
            ) : <span />}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <button type="button" className="text-brand font-semibold inline-flex items-center gap-1" onClick={() => setRows([...rows, { fundId: "", category: "", amount: left > 0 ? (left / 100).toFixed(2) : "" }])}>
            <Plus className="h-3.5 w-3.5" /> Split across another fund
          </button>
          <span className={clsx("tnum", left === 0 ? "text-good-ink" : "text-critical")}>
            {left === 0 ? `Adds up to ${usd(total)}` : left > 0 ? `${usd(left)} still to allocate` : `${usd(-left)} over the transaction amount`}
          </span>
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`reason-${t.id}`}>Reason (recorded in the audit log)</label>
        <input id={`reason-${t.id}`} className="input text-sm" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t.amount > 0 ? "e.g. Donor confirmed by email the gift is for the Asha appeal" : "e.g. Fuel for Asha distribution trucks, receipt #4417 on file"} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={busy || left !== 0 || reason.trim().length < 3 || rows.some((r) => !r.fundId)}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} {t.allocations.length ? "Retag" : "Tag"} {usd(total)}</button>
        {t.allocations.length > 0 && (
          <button type="button" className="btn btn-ghost" disabled={busy || reason.trim().length < 3} onClick={() => save([])} title="Reverse the ledger entries and send it back to the queue">
            Move back to queue
          </button>
        )}
        {err && <span className="text-sm text-critical" role="alert">{err}</span>}
      </div>
      {t.allocations.length > 0 ? (
        <p className="text-[11px] text-muted">A retag goes to a second person first. Once approved it never edits history: reversing entries are added to the old fund&apos;s ledger, then the new allocation is posted.</p>
      ) : total >= threshold ? (
        <p className="text-[11px] text-muted">This is {usd(threshold)} or more, so a second person has to approve the tag before it reaches the ledger.</p>
      ) : null}
      {t.history.length > 0 && (
        <div className="text-xs text-ink-2">
          <div className="font-semibold flex items-center gap-1 mb-1"><History className="h-3.5 w-3.5" /> Earlier tags</div>
          <ul className="space-y-0.5">
            {t.history.map((h, i) => (
              <li key={i}>
                {new Date(h.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {h.by}: {h.allocations.map((a) => `${usd(a.amount)} → ${funds.find((f) => f.id === a.fundId)?.title ?? a.fundId}`).join(", ")}
                {h.reason ? ` (“${h.reason}”)` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}

function BulkBar({ ids, funds, onDone, onClear }: { ids: string[]; funds: FundOpt[]; onDone: (m: string) => Promise<void>; onClear: () => void }) {
  const [fundId, setFundId] = useState("");
  const [category, setCategory] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="card p-3 mb-3 border-brand flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          const r = await api<{ message: string }>("/api/bank/transactions", { json: { action: "bulk_tag", ids, fundId, category: category || undefined, reason } });
          await onDone(r.message);
        } catch (x) {
          setErr((x as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="text-sm font-semibold self-center mr-1">{ids.length} selected</div>
      <div>
        <label className="label" htmlFor="bulk-fund">Tag all to</label>
        <select id="bulk-fund" className="input !py-1.5 text-sm" value={fundId} onChange={(e) => setFundId(e.target.value)} required>
          <option value="">Choose a fund…</option>
          {funds.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="bulk-cat">Category</label>
        <select id="bulk-cat" className="input !py-1.5 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">No category</option>
          {CATS.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
        </select>
      </div>
      <div className="flex-1 min-w-[14rem]">
        <label className="label" htmlFor="bulk-reason">Reason</label>
        <input id="bulk-reason" className="input !py-1.5 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Applies to every selected line; each gets its own audit entry" />
      </div>
      <button className="btn btn-primary" disabled={busy || !fundId || reason.trim().length < 3}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Tag {ids.length}</button>
      <button type="button" className="btn btn-ghost" onClick={onClear}>Clear</button>
      {err && <span className="text-sm text-critical w-full" role="alert">{err}</span>}
    </form>
  );
}

/** A change waiting for a second person: approve it (it's posted to the ledger) or turn it down (nothing changes). */
function PendingPanel({ t, onDone }: { t: Txn; onDone: (m: string) => Promise<void> }) {
  const p = t.pending!;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function act(action: "approve" | "reject") {
    setBusy(action);
    setErr(null);
    try {
      const r = await api<{ message: string }>("/api/bank/transactions", { json: { action, id: t.id, reason: note } });
      await onDone(r.message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="pt-3 grid gap-3 text-sm">
      <div className="rounded-lg border border-[#f0d9a8] bg-[#fffaf0] p-3">
        <div className="font-semibold">
          {p.byName} wants to {p.kind} this {t.amount < 0 ? "payment" : "receipt"} · {new Date(p.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </div>
        <div className="mt-1 text-ink-2">
          {t.allocations.length > 0 && <span>Now: {t.allocations.map((a) => `${usd(a.amount)} → ${a.fundTitle}`).join(", ")}. </span>}
          {p.kind === "untag" ? "Send it back to the Untagged queue." : <>Proposed: {p.allocations.map((a) => `${usd(a.amount)} → ${a.fundTitle}${a.category ? ` (${CAT_LABEL[a.category] ?? a.category})` : ""}`).join(", ")}.</>}
        </div>
        <div className="mt-1">Reason: “{p.reason}”</div>
        <div className="mt-1 text-[11px] text-muted">{p.why}. Nothing is posted to a ledger until it&apos;s approved.</div>
      </div>
      {p.canApprove || p.mine ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[14rem]">
            <label className="label" htmlFor={`note-${t.id}`}>Note (optional, goes in the audit log)</label>
            <input id={`note-${t.id}`} className="input !py-1.5 text-sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder={p.mine ? "Why you're withdrawing it" : "e.g. Checked against the invoice"} />
          </div>
          {p.canApprove && (
            <button className="btn btn-primary" disabled={!!busy} onClick={() => act("approve")}>
              {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Approve
            </button>
          )}
          <button className="btn btn-ghost" disabled={!!busy} onClick={() => act("reject")}>
            {busy === "reject" && <Loader2 className="h-4 w-4 animate-spin" />} {p.mine ? "Withdraw request" : "Turn down"}
          </button>
        </div>
      ) : (
        <p className="text-ink-2">An admin, or someone else assigned to every fund involved, has to approve this.</p>
      )}
      {p.mine && <p className="text-[11px] text-muted">You made this change, so someone else has to approve it.</p>}
      {err && <span className="text-sm text-critical" role="alert">{err}</span>}
    </div>
  );
}

/** Receipts and invoices attached to a bank line as evidence. Reading them never changes the tag. */
function ReceiptsPanel({ t, onChanged }: { t: Txn; onChanged: (m: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function upload(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/bank/transactions/${t.id}/receipts`, { method: "POST", body: fd });
      const j = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) throw new Error(j.error || `Upload failed (${res.status})`);
      await onChanged(j.message ?? "Receipt attached");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 pt-3 border-t border-line text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold flex items-center gap-1.5">
          <Receipt className="h-4 w-4" /> Receipts {t.receipts.length > 0 && <span className="text-muted font-normal">({t.receipts.length})</span>}
          {t.missingReceipt && <Pill tone="warn">Needed</Pill>}
        </div>
        <label className={clsx("btn btn-ghost !py-1 text-xs cursor-pointer", busy && "opacity-60 pointer-events-none")}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />} {busy ? "Reading…" : "Attach receipt"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f);
            }}
          />
        </label>
      </div>
      {t.receipts.length === 0 ? (
        <p className="text-xs text-muted mt-1">
          Attach the invoice or bill behind this {t.amount < 0 ? "payment" : "receipt"} (image or PDF, up to 8 MB). Claude reads it and a fixed rule checks it against the amount, date and payee. It never changes the tag.
        </p>
      ) : (
        <ul className="mt-2 grid md:grid-cols-2 gap-2">
          {t.receipts.map((r) => (
            <li key={r.fileId} className="rounded-lg border border-line p-3 text-xs">
              <div className="flex items-start justify-between gap-2">
                <a href={r.url} target="_blank" rel="noreferrer" className="font-medium inline-flex items-center gap-1 underline break-all">
                  <FileText className="h-3.5 w-3.5 shrink-0" /> {r.fileName}
                </a>
                {r.extraction && <Pill tone={r.match.score >= 75 ? "good" : r.match.score >= 50 ? "neutral" : "warn"}>Match {r.match.score}/100</Pill>}
              </div>
              {r.extraction && (
                <div className="mt-1 text-ink-2">
                  {[
                    r.extraction.supplier,
                    r.extraction.invoiceNumber && `No. ${r.extraction.invoiceNumber}`,
                    r.extraction.date,
                    r.extraction.total != null && `${r.extraction.currency ?? ""} ${r.extraction.total.toLocaleString()}`.trim(),
                    r.extraction.printedCode && `#${r.extraction.printedCode}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              )}
              {r.extraction && (
                <ul className="mt-1 text-muted list-disc pl-4">
                  {r.match.signals.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              )}
              {r.codeMismatch && <div className="mt-1 text-critical">{r.codeMismatch}. The tag is not changed; check it.</div>}
              {r.note && <div className="mt-1 text-muted">{r.note}</div>}
              <div className="mt-1 text-muted">Added by {r.byName} · {new Date(r.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
            </li>
          ))}
        </ul>
      )}
      {err && <p className="text-sm text-critical mt-1" role="alert">{err}</p>}
    </div>
  );
}
