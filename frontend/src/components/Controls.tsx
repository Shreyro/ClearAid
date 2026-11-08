"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, useJson } from "./hooks";
import { CAT_LABEL } from "./SpendCard";

type Resp = {
  controls: {
    tagApprovalThreshold: number;
    receiptThreshold: number;
    feePolicy: { mode: "unallocated" | "fund"; fundId?: string; category?: string };
    updatedAt?: string;
    updatedBy?: string;
  };
  unallocatedFees: number;
};
type Fund = { id: string; title: string; status: string };

/** Admin-set tracking controls: when a second person must sign off a tag, when a receipt is expected, and where bank fees go. */
export function Controls() {
  const { data, reload } = useJson<Resp>("/api/ngo/controls");
  const { data: fundsResp } = useJson<{ funds: Fund[] }>("/api/bank/transactions?status=fees");
  const [approval, setApproval] = useState("");
  const [receipt, setReceipt] = useState("");
  const [mode, setMode] = useState<"unallocated" | "fund">("unallocated");
  const [fundId, setFundId] = useState("");
  const [category, setCategory] = useState("admin");
  const [applyExisting, setApplyExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!data) return;
    const c = data.controls;
    /* eslint-disable react-hooks/set-state-in-effect */
    setApproval(String(c.tagApprovalThreshold / 100));
    setReceipt(String(c.receiptThreshold / 100));
    setMode(c.feePolicy.mode);
    setFundId(c.feePolicy.fundId ?? "");
    setCategory(c.feePolicy.category ?? "admin");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [data]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ message: string }>("/api/ngo/controls", {
        json: {
          tagApprovalThresholdUsd: Number(approval),
          receiptThresholdUsd: Number(receipt),
          feePolicy: mode === "fund" ? { mode, fundId, category } : { mode },
          applyToExistingFees: mode === "fund" && applyExisting,
        },
      });
      setMsg({ ok: true, text: r.message });
      setApplyExisting(false);
      await reload();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="card p-6"><Loader2 className="h-5 w-5 animate-spin text-muted" /></div>;
  const openFunds = (fundsResp?.funds ?? []).filter((f) => f.status !== "closed");

  return (
    <form onSubmit={save} className="grid gap-4 max-w-3xl">
      <section className="card p-5">
        <h2 className="font-semibold">Second-person sign-off</h2>
        <p className="text-sm text-ink-2 mt-1">
          Manual tags at or above this amount wait on the Untagged page until someone else approves them. Retags and untags of money already on a ledger always need sign-off. The person who made a change can&apos;t approve it.
        </p>
        <label className="label mt-3" htmlFor="ctl-approval">Sign-off needed from (USD)</label>
        <input id="ctl-approval" className="input !w-48 tnum" type="number" min="0" step="1" value={approval} onChange={(e) => setApproval(e.target.value)} required />
      </section>

      <section className="card p-5">
        <h2 className="font-semibold">Receipts</h2>
        <p className="text-sm text-ink-2 mt-1">Tagged bank payments at or above this amount are listed under &ldquo;Missing receipts&rdquo; until a receipt or invoice is attached.</p>
        <label className="label mt-3" htmlFor="ctl-receipt">Receipt expected from (USD)</label>
        <input id="ctl-receipt" className="input !w-48 tnum" type="number" min="0" step="1" value={receipt} onChange={(e) => setReceipt(e.target.value)} required />
      </section>

      <section className="card p-5">
        <h2 className="font-semibold">Bank fees</h2>
        <p className="text-sm text-ink-2 mt-1">
          Where bank charges with no tracking code are charged. A code in the fee&apos;s own description always wins. The policy applies to fees imported after you save; tick the box to apply it to the {data.unallocatedFees} fee{data.unallocatedFees === 1 ? "" : "s"} already waiting.
        </p>
        <div className="mt-3 grid gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="fee-mode" checked={mode === "unallocated"} onChange={() => setMode("unallocated")} /> Leave unallocated (general fund), listed under &ldquo;Bank fees&rdquo;
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="fee-mode" checked={mode === "fund"} onChange={() => setMode("fund")} /> Charge them to a fund
          </label>
        </div>
        {mode === "fund" && (
          <div className="mt-3 flex flex-wrap gap-3 items-end">
            <div>
              <label className="label" htmlFor="ctl-fund">Fund</label>
              <select id="ctl-fund" className="input" value={fundId} onChange={(e) => setFundId(e.target.value)} required>
                <option value="">Choose a fund…</option>
                {openFunds.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="ctl-cat">Category</label>
              <select id="ctl-cat" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                {Object.entries(CAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            {data.unallocatedFees > 0 && (
              <label className="flex items-center gap-2 text-sm pb-2">
                <input type="checkbox" checked={applyExisting} onChange={(e) => setApplyExisting(e.target.checked)} /> Also charge the {data.unallocatedFees} waiting fee{data.unallocatedFees === 1 ? "" : "s"}
              </label>
            )}
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Save controls</button>
        {data.controls.updatedBy && <span className="text-xs text-muted">Last changed by {data.controls.updatedBy}{data.controls.updatedAt ? ` on ${new Date(data.controls.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}. Every change is in the audit log.</span>}
        {msg && <span className={msg.ok ? "text-sm text-good-ink" : "text-sm text-critical"} role={msg.ok ? "status" : "alert"}>{msg.text}</span>}
      </div>
    </form>
  );
}
