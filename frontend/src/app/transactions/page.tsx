"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { Download, Loader2, Plus, X } from "lucide-react";
import clsx from "clsx";
import { Page, useMe } from "@/components/AppShell";
import { api, useJson, useLive, usd } from "@/components/hooks";
import { gridTheme } from "@/components/LedgerGrid";

type Tx = {
  id: string;
  seq: number;
  fundId: string;
  fundTitle: string;
  ts: string;
  type: string;
  typeLabel: string;
  direction: "in" | "out" | "notice";
  amount: number;
  from: string;
  to: string;
  counterparty: string;
  counterpartyEmail?: string;
  via?: string;
  detailHref?: string;
  memo: string;
  ref?: string;
  paypalRef?: string;
  hash: string;
};
type Resp = { transactions: Tx[]; totals: { in: number; out: number; count: number }; funds: { id: string; title: string }[] };

export default function TransactionsPage() {
  const { me } = useMe();
  const [fund, setFund] = useState("");
  const [direction, setDirection] = useState("money");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [recording, setRecording] = useState(false);

  // Deep links from Money flow and Sources (?direction=…&q=…&fund=…).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    /* eslint-disable react-hooks/set-state-in-effect */
    if (p.get("direction")) setDirection(p.get("direction")!);
    if (p.get("q")) setQ(p.get("q")!);
    if (p.get("fund")) setFund(p.get("fund")!);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const params = new URLSearchParams();
  if (fund) params.set("fund", fund);
  if (direction !== "money") params.set("direction", direction);
  if (q.trim()) params.set("q", q.trim());
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  const { data, reload } = useJson<Resp>(`/api/transactions${qs ? `?${qs}` : ""}`);
  useLive(undefined, (e) => {
    if (e.kind === "ledger") void reload();
  });

  const cols = useMemo<ColDef<Tx>[]>(
    () => [
      { field: "ts", headerName: "Date", width: 150, sort: "desc", valueFormatter: (p) => new Date(p.value).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) },
      { field: "from", headerName: "From", width: 220, tooltipValueGetter: (p) => (p.data?.direction === "in" ? [p.data.from, p.data.counterpartyEmail].filter(Boolean).join(" · ") : p.data?.from) },
      { colId: "arrow", headerName: "", width: 36, sortable: false, valueGetter: (p) => (p.data?.direction === "notice" ? "" : "→"), cellClass: "text-muted text-center" },
      { field: "to", headerName: "To", width: 220, tooltipValueGetter: (p) => (p.data?.direction === "out" ? [p.data.to, p.data.counterpartyEmail].filter(Boolean).join(" · ") : p.data?.to) },
      {
        field: "amount",
        headerName: "Amount",
        width: 125,
        type: "rightAligned",
        cellClass: "tnum",
        valueFormatter: (p) => (p.value === 0 ? "—" : `${p.value > 0 ? "+" : "−"}${usd(Math.abs(p.value))}`),
        cellStyle: (p) => ({ color: p.value < 0 ? "#9b3d17" : p.value > 0 ? "#006300" : "#898781", fontWeight: 600 }),
      },
      { field: "via", headerName: "Via", width: 190, tooltipField: "via" },
      { field: "typeLabel", headerName: "Type", width: 140 },
      { field: "memo", headerName: "Memo", flex: 1, minWidth: 240, tooltipField: "memo" },
      { field: "paypalRef", headerName: "Reference", width: 170, cellClass: "font-mono text-xs" },
      {
        field: "detailHref",
        headerName: "",
        width: 90,
        sortable: false,
        cellRenderer: (p: { data?: Tx }) => (p.data?.detailHref ? <Link href={p.data.detailHref} className="text-brand underline text-xs">Evidence →</Link> : null),
      },
      { field: "hash", headerName: "Ledger hash", width: 120, valueFormatter: (p) => `${String(p.value).slice(0, 10)}…`, cellClass: "font-mono text-xs", tooltipField: "hash" },
    ],
    [],
  );

  const net = data ? data.totals.in - data.totals.out : 0;
  return (
    <Page
      wide
      title="Transactions"
      subtitle="Every movement into and out of the funds you can see: who it came from, who it went to and how it moved, straight from each fund's hash-chained ledger."
      actions={
        <>
          <a href={`/api/transactions?${new URLSearchParams({ ...Object.fromEntries(params), format: "csv" })}`} className="btn btn-ghost"><Download className="h-4 w-4" /> Export CSV</a>
          <button className="btn btn-primary" onClick={() => setRecording((r) => !r)}>{recording ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />} Record incoming</button>
        </>
      }
    >
      {recording && <RecordIncoming funds={data?.funds ?? []} isAdmin={me.role === "admin"} onDone={() => { setRecording(false); void reload(); }} />}

      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="card p-3"><div className="text-xs text-muted">Money in</div><div className="text-lg font-semibold tnum text-good-ink">{data ? usd(data.totals.in) : "—"}</div></div>
        <div className="card p-3"><div className="text-xs text-muted">Money out</div><div className="text-lg font-semibold tnum text-[#9b3d17]">{data ? usd(data.totals.out) : "—"}</div></div>
        <div className="card p-3"><div className="text-xs text-muted">Net · {data?.totals.count ?? 0} entries</div><div className="text-lg font-semibold tnum">{data ? `${net < 0 ? "−" : ""}${usd(Math.abs(net))}` : "—"}</div></div>
      </div>

      <div className="flex flex-wrap items-end gap-2 mb-3">
        <div className="min-w-[12rem] flex-1 sm:flex-none">
          <label className="label" htmlFor="tx-fund">Fund</label>
          <select id="tx-fund" className="input !py-1.5 text-sm" value={fund} onChange={(e) => setFund(e.target.value)}>
            <option value="">All funds</option>
            {data?.funds.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
          </select>
        </div>
        <div>
          <span className="label">Direction</span>
          <div className="flex rounded-lg border border-line overflow-hidden text-xs font-semibold">
            {[["money", "All money"], ["in", "In"], ["out", "Out"], ["all", "Incl. notices"]].map(([k, l]) => (
              <button key={k} onClick={() => setDirection(k)} className={clsx("px-3 py-2", direction === k ? "bg-brand-wash text-brand-ink" : "bg-surface text-ink-2")}>{l}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="label" htmlFor="tx-from">From</label>
          <input id="tx-from" type="date" className="input !py-1.5 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="tx-to">To</label>
          <input id="tx-to" type="date" className="input !py-1.5 text-sm" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[12rem]">
          <label className="label" htmlFor="tx-q">Search</label>
          <input id="tx-q" className="input !py-1.5 text-sm" placeholder="Payer, payee, memo or reference" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <div style={{ height: "calc(100vh - 330px)", minHeight: 420 }}>
        <AgGridReact<Tx> theme={gridTheme} rowData={data?.transactions ?? []} columnDefs={cols} getRowId={(p) => p.data.id} pagination paginationPageSize={100} paginationPageSizeSelector={false} tooltipShowDelay={300} enableCellTextSelection loading={!data} />
      </div>
    </Page>
  );
}

function RecordIncoming({ funds, isAdmin, onDone }: { funds: { id: string; title: string }[]; isAdmin: boolean; onDone: () => void }) {
  const [f, setF] = useState({ fundId: funds[0]?.id ?? "", amountUsd: "", payerName: "", payerEmail: "", method: "bank_transfer", reference: "", receivedAt: new Date().toISOString().slice(0, 10) });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/transactions", { json: { ...f, amountUsd: Number(f.amountUsd) } });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card p-5 mb-5 border-brand">
      <h2 className="font-semibold">Record money received</h2>
      <p className="text-xs text-ink-2 mt-0.5">For funds that arrive outside PayPal checkout: bank transfers, cheques, cash or grants. It&apos;s added to the fund&apos;s ledger and the audit log under your name, and can&apos;t be edited afterwards. {!isAdmin && "You can record for funds you're an approver on."}</p>
      <form
        className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="lg:col-span-2"><label className="label" htmlFor="rx-fund">Fund</label><select id="rx-fund" className="input" value={f.fundId} onChange={(e) => setF({ ...f, fundId: e.target.value })}>{funds.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></div>
        <div><label className="label" htmlFor="rx-amt">Amount (USD)</label><input id="rx-amt" className="input tnum" type="number" min="0.01" step="0.01" value={f.amountUsd} onChange={(e) => setF({ ...f, amountUsd: e.target.value })} /></div>
        <div><label className="label" htmlFor="rx-date">Received on</label><input id="rx-date" className="input" type="date" max={new Date().toISOString().slice(0, 10)} value={f.receivedAt} onChange={(e) => setF({ ...f, receivedAt: e.target.value })} /></div>
        <div><label className="label" htmlFor="rx-name">From (payer)</label><input id="rx-name" className="input" placeholder="e.g. Rotary Club of Puri" value={f.payerName} onChange={(e) => setF({ ...f, payerName: e.target.value })} /></div>
        <div><label className="label" htmlFor="rx-email">Payer email (optional)</label><input id="rx-email" className="input" type="email" value={f.payerEmail} onChange={(e) => setF({ ...f, payerEmail: e.target.value })} /></div>
        <div>
          <label className="label" htmlFor="rx-method">Method</label>
          <select id="rx-method" className="input" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            <option value="bank_transfer">Bank transfer</option>
            <option value="cheque">Cheque</option>
            <option value="cash">Cash</option>
            <option value="grant">Grant</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div><label className="label" htmlFor="rx-ref">Reference</label><input id="rx-ref" className="input font-mono" placeholder="Bank txn ID / cheque no." value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></div>
        <div className="sm:col-span-2 lg:col-span-4 flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" disabled={busy || !f.fundId || !f.amountUsd || !f.payerName.trim() || !f.reference.trim()}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Add to ledger</button>
          {err && <span className="text-sm text-critical" role="alert">{err}</span>}
        </div>
      </form>
    </section>
  );
}
