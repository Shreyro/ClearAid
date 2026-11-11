"use client";

import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { Download, Loader2, ShieldCheck, ShieldX } from "lucide-react";
import clsx from "clsx";
import { Page, useMe } from "@/components/AppShell";
import { api, useJson, useLive } from "@/components/hooks";
import { gridTheme } from "@/components/LedgerGrid";

type Entry = {
  seq: number;
  ts: string;
  actorId: string;
  actorName: string;
  action: string;
  fundId?: string;
  fundTitle?: string;
  targetId?: string;
  summary: string;
  meta?: Record<string, string | number | boolean>;
  prevHash: string;
  hash: string;
};
type Resp = {
  entries: Entry[];
  total: number;
  chain: { valid: boolean; head?: string; brokenAt?: number; length: number };
  actors: { id: string; name: string }[];
};

const CATEGORIES: [string, string][] = [
  ["", "All activity"],
  ["auth", "Sign-ins"],
  ["withdrawal", "Payments & approvals"],
  ["transaction", "Recorded transactions"],
  ["bank", "Bank, tagging & receipts"],
  ["ngo", "Tracking controls"],
  ["refund", "Refunds"],
  ["assignment", "Fund access"],
  ["member", "Team changes"],
  ["fund", "Fund setup"],
  ["vendor", "Vendors"],
  ["embed", "Public embeds"],
  ["export", "Data exports"],
];

const TONE: Record<string, string> = {
  auth: "bg-hover text-ink-2",
  withdrawal: "bg-info-wash text-info-ink",
  transaction: "bg-good-wash text-good-ink",
  bank: "bg-brand-wash text-brand-deep",
  ngo: "bg-warn-wash text-warn-ink",
  refund: "bg-warn-wash text-warn-ink",
  assignment: "bg-brand-wash text-brand-ink",
  member: "bg-brand-wash text-brand-ink",
  fund: "bg-ai-wash text-ai-ink",
  vendor: "bg-ai-wash text-ai-ink",
  embed: "bg-info-wash text-info-ink",
  export: "bg-hover text-ink-2",
  demo: "bg-bad-wash text-bad-ink",
};

/** Must match canonicalAudit() in backend/src/lib/audit.ts byte for byte. */
const canonical = (e: Omit<Entry, "hash" | "fundTitle">) => [e.seq, e.ts, e.actorId, e.actorName, e.action, e.fundId ?? "", e.targetId ?? "", e.summary, e.meta ? JSON.stringify(e.meta) : "", e.prevHash].join("|");
async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function AuditPage() {
  const { me } = useMe();
  const isAdmin = me.role === "admin";
  const [category, setCategory] = useState("");
  const [actor, setActor] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [verify, setVerify] = useState<{ state: "idle" | "running" | "ok" | "bad"; detail?: string }>({ state: "idle" });

  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (actor) params.set("actor", actor);
  if (q.trim()) params.set("q", q.trim());
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  const { data, reload } = useJson<Resp>(`/api/audit${qs ? `?${qs}` : ""}`);
  useLive(undefined, () => void reload());

  const cols = useMemo<ColDef<Entry>[]>(
    () => [
      { field: "seq", headerName: "#", width: 70, cellClass: "tnum" },
      { field: "ts", headerName: "Time", width: 165, valueFormatter: (p) => new Date(p.value).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) },
      { field: "actorName", headerName: "Who", width: 170 },
      {
        field: "action",
        headerName: "Action",
        width: 200,
        cellRenderer: (p: { value: string }) => <span className={clsx("inline-block rounded-full px-2 py-0.5 text-xs font-semibold font-mono", TONE[p.value.split(".")[0]] ?? TONE.auth)}>{p.value}</span>,
      },
      { field: "fundTitle", headerName: "Fund", width: 190, tooltipField: "fundTitle" },
      { field: "summary", headerName: "What happened", flex: 1, minWidth: 320, tooltipField: "summary" },
      { field: "hash", headerName: "Entry hash", width: 120, valueFormatter: (p) => `${String(p.value).slice(0, 10)}…`, cellClass: "font-mono text-xs", tooltipField: "hash" },
    ],
    [],
  );

  async function runVerify() {
    setVerify({ state: "running" });
    try {
      const full = await api<{ full?: Entry[] }>("/api/audit?chain=1");
      const entries = full.full ?? [];
      let prev = "0".repeat(64);
      for (const [i, e] of entries.entries()) {
        const { hash, fundTitle: _t, ...rest } = e;
        void _t;
        const h = await sha256(canonical(rest));
        if (e.prevHash !== prev || e.seq !== i || h !== hash) {
          setVerify({ state: "bad", detail: `Chain breaks at entry #${e.seq}` });
          return;
        }
        prev = h;
      }
      setVerify({ state: "ok", detail: `${entries.length} entries recomputed in your browser · head ${prev.slice(0, 16)}…` });
    } catch (e) {
      setVerify({ state: "bad", detail: (e as Error).message });
    }
  }

  return (
    <Page
      wide
      title="Audit log"
      subtitle={
        isAdmin
          ? "Every sign-in, approval, payment, access change and export across your NGO, in one tamper-evident hash chain."
          : "Activity on the funds you're assigned to, plus your own sign-ins and requests. Admins can see the full log."
      }
      actions={
        <>
          {isAdmin && (
            <button onClick={runVerify} className="btn btn-ghost" disabled={verify.state === "running"}>
              {verify.state === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Verify chain
            </button>
          )}
          <a href={`/api/audit?${new URLSearchParams({ ...Object.fromEntries(params), format: "csv" })}`} className="btn btn-ghost"><Download className="h-4 w-4" /> Export CSV</a>
        </>
      }
    >
      {data && (
        <div className={clsx("card p-3 mb-4 text-sm flex flex-wrap items-center gap-x-3 gap-y-1", data.chain.valid ? "bg-good-soft border-good-line" : "bg-bad-soft border-bad-line")}>
          {data.chain.valid ? <ShieldCheck className="h-4 w-4 text-good-ink" /> : <ShieldX className="h-4 w-4 text-critical" />}
          <span className="font-medium">{data.chain.valid ? "Audit chain intact" : `Audit chain broken at entry #${data.chain.brokenAt}`}</span>
          <span className="text-ink-2">{data.chain.length} entries in total{data.chain.head && <> · head <span className="font-mono text-xs">{data.chain.head.slice(0, 16)}…</span></>}</span>
          {verify.state === "ok" && <span className="text-good-ink text-xs">Independently verified: {verify.detail}</span>}
          {verify.state === "bad" && <span className="text-critical text-xs">{verify.detail}</span>}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2 mb-3">
        <div>
          <label className="label" htmlFor="au-cat">Activity</label>
          <select id="au-cat" className="input !py-1.5 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="au-actor">Person</label>
          <select id="au-actor" className="input !py-1.5 text-sm" value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">Anyone</option>
            {data?.actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="au-from">From</label>
          <input id="au-from" type="date" className="input !py-1.5 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="au-to">To</label>
          <input id="au-to" type="date" className="input !py-1.5 text-sm" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[12rem]">
          <label className="label" htmlFor="au-q">Search</label>
          <input id="au-q" className="input !py-1.5 text-sm" placeholder="Name, fund or description" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="text-xs text-muted pb-2">{data ? `${data.total} matching` : ""}</span>
      </div>

      <div style={{ height: "calc(100vh - 340px)", minHeight: 420 }}>
        <AgGridReact<Entry> theme={gridTheme} rowData={data?.entries ?? []} columnDefs={cols} getRowId={(p) => String(p.data.seq)} pagination paginationPageSize={100} paginationPageSizeSelector={false} tooltipShowDelay={300} enableCellTextSelection loading={!data} />
      </div>
    </Page>
  );
}
