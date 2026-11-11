"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Landmark, Loader2, Lock, Plus, X } from "lucide-react";
import clsx from "clsx";
import { api, useJson, usd } from "./hooks";
import { Section } from "./ui";

type Preview = {
  status: "active" | "closing" | "closed";
  held: number;
  movedOut: number;
  fromDonors: number;
  targets: { id: string; title: string; slug: string; accent: string }[];
};
type Row = { fundId: string; amount: string };

const cents = (s: string) => Math.round(Number(s || 0) * 100);

/**
 * Admin-only: close a fund and decide where its leftover money goes. Whatever
 * isn't moved to another open fund stays in the bank, held on this fund.
 * `stamp` changes whenever the fund's ledger does, so the numbers stay current.
 */
export function CloseFund({ fundId, title, stamp, onDone }: { fundId: string; title: string; stamp: unknown; onDone: () => void }) {
  const { data, reload } = useJson<Preview>(`/api/funds/${fundId}/close`);
  const [rows, setRows] = useState<Row[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void reload();
  }, [stamp, reload]);

  if (!data) return null;
  if (data.status === "closed" && data.held === 0) return null;

  const moving = rows.reduce((a, r) => a + (r.fundId ? cents(r.amount) : 0), 0);
  const left = data.held - moving;
  const bad = rows.some((r) => r.amount && (!r.fundId || !(cents(r.amount) > 0))) || moving > data.held;
  const used = new Set(rows.map((r) => r.fundId));
  const freeTargets = data.targets.filter((t) => !used.has(t.id));

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { fundId: freeTargets[0]?.id ?? "", amount: "" }]);

  async function send(action: "start" | "finalize" | "move") {
    setBusy(true);
    setErr(null);
    try {
      const transfers = rows.filter((r) => r.fundId && cents(r.amount) > 0).map((r) => ({ fundId: r.fundId, amountUsd: Number(r.amount) }));
      const r = await api<{ moved?: number; held?: number }>(`/api/funds/${fundId}/close`, { json: { action, transfers } });
      setDone(
        action === "start"
          ? "Closing started. No new money can be tagged to this fund; decide below where the leftover goes."
          : `${r.moved ? `${usd(r.moved)} moved. ` : ""}${r.held ? `${usd(r.held)} stays in the bank, held on this fund.` : "Nothing is left on the fund."}`,
      );
      setRows([]);
      setConfirming(false);
      await reload();
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ---- Step 1: an open fund.
  if (data.status === "active")
    return (
      <div className="card p-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm max-w-2xl">
          <span className="font-semibold">Close this fund.</span>{" "}
          <span className="text-ink-2">Stops new money being tagged to it. You then choose how much of the {usd(data.held)} still held moves to other funds; the rest stays in the bank and stays tracked here.</span>
        </p>
        {confirming ? (
          <div className="flex gap-2">
            <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
            <button className="btn btn-danger" disabled={busy} onClick={() => send("start")}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} Yes, start closing
            </button>
          </div>
        ) : (
          <button className="btn btn-ghost" onClick={() => setConfirming(true)}><Lock className="h-4 w-4" /> Start closing</button>
        )}
        {err && <p className="w-full text-sm text-critical">{err}</p>}
      </div>
    );

  // ---- Step 2 (closing) or later (closed with money still held): where the leftover goes.
  const closing = data.status === "closing";
  return (
    <Section title={closing ? `Close ${title}` : "Money still held after closure"}>
      <div className="space-y-4">
        {done && <div className="rounded-lg bg-brand-wash border border-brand-line p-3 text-sm">{done}</div>}
        <p className="text-sm text-ink-2 max-w-3xl">
          <b className="text-ink">{usd(data.held)}</b> is still held on this fund
          {data.fromDonors > 0 && data.fromDonors < data.held && <> ({usd(data.fromDonors)} of it from PayPal gifts, the rest from the bank)</>}.{" "}
          {closing
            ? "Choose how much moves to other open funds. Whatever you don't move stays in the bank and stays tracked on this fund, and you can still move it later."
            : "It is in the bank and tracked here. You can move some or all of it to another open fund."}
          {data.movedOut > 0 && <> {usd(data.movedOut)} has already moved to other funds.</>}
        </p>

        {data.targets.length === 0 ? (
          <div className="rounded-lg bg-sunken border border-line p-3 text-sm flex gap-2">
            <Landmark className="h-4 w-4 mt-0.5 shrink-0 text-muted" />
            <span>There are no other open funds to move money to, so all {usd(data.held)} stays in the bank, held on this fund. Open a new fund in Settings if you want to move it later.</span>
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((r, i) => {
              const options = data.targets.filter((t) => t.id === r.fundId || !used.has(t.id));
              const others = moving - (r.fundId ? cents(r.amount) : 0);
              return (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <ArrowRight className="h-4 w-4 text-muted shrink-0" aria-hidden />
                  <select className="input !w-auto min-w-[14rem] flex-1 sm:flex-none" value={r.fundId} onChange={(e) => setRow(i, { fundId: e.target.value })} aria-label={`Fund for transfer ${i + 1}`}>
                    <option value="">Choose a fund…</option>
                    {options.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                  </select>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm">$</span>
                    <input
                      className={clsx("input !w-36 pl-6 tnum", r.amount && !(cents(r.amount) > 0) && "border-bad-line")}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={r.amount}
                      onChange={(e) => setRow(i, { amount: e.target.value.replace(/[^0-9.]/g, "") })}
                      aria-label={`Amount for transfer ${i + 1}`}
                    />
                  </div>
                  <button type="button" className="text-xs underline text-ink-2 hover:text-ink" onClick={() => setRow(i, { amount: (Math.max(0, data.held - others) / 100).toFixed(2) })}>
                    Rest
                  </button>
                  <button type="button" className="p-1.5 text-muted hover:text-critical rounded" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove transfer ${i + 1}`}>
                    <X className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
            {freeTargets.length > 0 && (
              <button type="button" className="btn btn-ghost !py-1 text-sm" onClick={addRow}>
                <Plus className="h-4 w-4" /> {rows.length ? "Move to another fund" : "Move money to a fund"}
              </button>
            )}
          </div>
        )}

        <div className="rounded-lg border border-line divide-y divide-line text-sm max-w-md">
          <div className="flex justify-between px-3 py-2"><span className="text-ink-2">Moves to other funds</span><span className="tnum font-medium">{usd(moving)}</span></div>
          <div className={clsx("flex justify-between px-3 py-2", left < 0 && "text-critical")}>
            <span className={left < 0 ? "" : "text-ink-2"}>{left < 0 ? "More than is held" : "Stays in the bank, held on this fund"}</span>
            <span className="tnum font-semibold">{usd(Math.abs(left))}</span>
          </div>
        </div>

        {err && <p className="text-sm text-critical">{err}</p>}

        <div className="flex flex-wrap gap-2">
          {closing ? (
            confirming ? (
              <>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>Back</button>
                <button className="btn btn-danger" disabled={busy || bad} onClick={() => send("finalize")}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} Close the fund{moving ? ` and move ${usd(moving)}` : ""}
                </button>
                <span className="text-xs text-muted self-center">This can&apos;t be undone.</span>
              </>
            ) : (
              <button className="btn btn-primary" disabled={bad} onClick={() => setConfirming(true)}>Close fund…</button>
            )
          ) : (
            <button className="btn btn-primary" disabled={busy || bad || moving === 0} onClick={() => send("move")}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Move {usd(moving)}
            </button>
          )}
        </div>
      </div>
    </Section>
  );
}
