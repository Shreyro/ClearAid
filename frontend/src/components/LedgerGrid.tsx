"use client";

import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from "ag-grid-community";
import { Download, ShieldCheck, ShieldX, Loader2 } from "lucide-react";
import { usd } from "./hooks";

ModuleRegistry.registerModules([AllCommunityModule]);

export const gridTheme = themeQuartz.withParams({
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 600,
  borderColor: "var(--line)",
  headerBackgroundColor: "var(--surface-2)",
  rowHoverColor: "var(--page)",
  accentColor: "var(--brand)",
  wrapperBorderRadius: 12,
  spacing: 6,
});

export type LedgerEntry = {
  seq: number;
  fundId: string;
  ts: string;
  type: string;
  amount: number;
  memo: string;
  actor: string;
  ref?: string;
  paypalRef?: string;
  prevHash: string;
  hash: string;
};

const TYPE_LABEL: Record<string, string> = {
  fund_opened: "Fund opened",
  donation: "Donation",
  withdrawal: "Vendor payout",
  expense: "Declared payment",
  withdrawal_rejected: "Request rejected",
  refund: "Refund",
  refund_reversed: "Return came back",
  carry_forward_out: "Carried forward out",
  carry_forward_in: "Carried forward in",
  dispute_opened: "Dispute opened",
  fund_closing: "Closing started",
  fund_closed: "Fund closed",
};

/** Must match canonical() in src/lib/ledger.ts byte for byte. */
const canonical = (e: LedgerEntry) => [e.seq, e.fundId, e.ts, e.type, e.amount, e.memo, e.actor, e.ref ?? "", e.paypalRef ?? "", e.prevHash].join("|");

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function LedgerGrid({ entries, fundId }: { entries: LedgerEntry[]; fundId: string }) {
  const [verify, setVerify] = useState<{ state: "idle" | "running" | "ok" | "bad"; detail?: string }>({ state: "idle" });
  const [filter, setFilter] = useState("all");

  const rows = useMemo(() => {
    const list = [...entries].reverse();
    if (filter === "in") return list.filter((e) => e.amount > 0);
    if (filter === "out") return list.filter((e) => e.amount < 0);
    if (filter === "notices") return list.filter((e) => e.amount === 0);
    return list;
  }, [entries, filter]);

  const cols = useMemo<ColDef<LedgerEntry>[]>(
    () => [
      { field: "seq", headerName: "#", width: 70, cellClass: "tnum" },
      { field: "ts", headerName: "Time", width: 150, valueFormatter: (p) => new Date(p.value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }), sort: undefined },
      { field: "type", headerName: "Event", width: 150, valueFormatter: (p) => TYPE_LABEL[p.value] ?? p.value },
      {
        field: "amount",
        headerName: "Amount",
        width: 120,
        type: "rightAligned",
        cellClass: "tnum",
        valueFormatter: (p) => (p.value === 0 ? "—" : `${p.value > 0 ? "+" : "−"}${usd(Math.abs(p.value))}`),
        cellStyle: (p) => ({ color: p.value < 0 ? "var(--out-ink)" : p.value > 0 ? "var(--good-ink)" : "var(--muted)", fontWeight: 600 }),
      },
      { field: "actor", headerName: "Who", width: 190 },
      { field: "memo", headerName: "Memo (PII-redacted)", flex: 1, minWidth: 260, tooltipField: "memo" },
      { field: "paypalRef", headerName: "PayPal reference", width: 190, cellClass: "font-mono text-xs" },
      { field: "hash", headerName: "Entry hash", width: 130, valueFormatter: (p) => `${String(p.value).slice(0, 10)}…`, cellClass: "font-mono text-xs", tooltipField: "hash" },
    ],
    [],
  );

  async function runVerify() {
    setVerify({ state: "running" });
    let prev = "0".repeat(64);
    for (const [i, e] of entries.entries()) {
      const h = await sha256(canonical(e));
      if (e.prevHash !== prev || e.seq !== i || h !== e.hash) {
        setVerify({ state: "bad", detail: `Chain breaks at entry #${e.seq}` });
        return;
      }
      prev = h;
    }
    setVerify({ state: "ok", detail: `${entries.length} entries recomputed in your browser · head ${prev.slice(0, 16)}…` });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex rounded-lg border border-line overflow-hidden text-xs font-semibold">
          {[
            ["all", "All"],
            ["in", "Money in"],
            ["out", "Money out"],
            ["notices", "Notices"],
          ].map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={`px-3 py-1.5 ${filter === k ? "bg-brand-wash text-brand-ink" : "bg-surface text-ink-2"}`}>
              {l}
            </button>
          ))}
        </div>
        <button onClick={runVerify} className="btn btn-ghost !py-1.5 text-xs" disabled={verify.state === "running"}>
          {verify.state === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} Verify hash chain
        </button>
        <a href={`/api/funds/${fundId}/ledger`} target="_blank" className="btn btn-ghost !py-1.5 text-xs" rel="noreferrer">
          <Download className="h-3.5 w-3.5" /> Raw JSON
        </a>
        {verify.state === "ok" && (
          <span className="text-xs text-good-ink flex items-center gap-1">
            <ShieldCheck className="h-3.5 w-3.5" /> Intact · {verify.detail}
          </span>
        )}
        {verify.state === "bad" && (
          <span className="text-xs text-critical flex items-center gap-1">
            <ShieldX className="h-3.5 w-3.5" /> {verify.detail}
          </span>
        )}
      </div>
      <div style={{ height: 420 }}>
        <AgGridReact<LedgerEntry> theme={gridTheme} rowData={rows} columnDefs={cols} getRowId={(p) => String(p.data.seq)} pagination paginationPageSize={50} paginationPageSizeSelector={false} tooltipShowDelay={300} enableCellTextSelection />
      </div>
      <p className="text-xs text-muted mt-2">
        Each entry stores the SHA-256 of the previous one, so editing or deleting any past entry breaks every hash after it. &quot;Verify&quot; recomputes the whole chain locally with WebCrypto, so auditors can check it without trusting the server.
      </p>
    </div>
  );
}
