"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Landmark, Loader2, Lock, Plus, Undo2, X } from "lucide-react";
import clsx from "clsx";
import { api, useJson, usd } from "./hooks";
import { Section } from "./ui";
import { DataGrid } from "./DataGrid";

type Preview = {
  status: "active" | "closing" | "closed";
  held: number;
  movedOut: number;
  fromDonors: number;
  /** Owed to donors who asked for their share back and not sent yet; it can't be moved. */
  owedToDonors: number;
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

  const owed = data.owedToDonors ?? 0;
  const free = Math.max(0, data.held - owed);
  const moving = rows.reduce((a, r) => a + (r.fundId ? cents(r.amount) : 0), 0);
  const left = data.held - owed - moving;
  const bad = rows.some((r) => r.amount && (!r.fundId || !(cents(r.amount) > 0))) || moving > free;
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
    <>
    <DonorReturns fundId={fundId} stamp={stamp} onDone={() => { void reload(); onDone(); }} />
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
                  <button type="button" className="text-xs underline text-ink-2 hover:text-ink" onClick={() => setRow(i, { amount: (Math.max(0, free - others) / 100).toFixed(2) })}>
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
          {owed > 0 && <div className="flex justify-between px-3 py-2"><span className="text-ink-2">Owed to donors who asked for their share</span><span className="tnum font-medium">{usd(owed)}</span></div>}
          <div className="flex justify-between px-3 py-2"><span className="text-ink-2">Moves to other funds</span><span className="tnum font-medium">{usd(moving)}</span></div>
          <div className={clsx("flex justify-between px-3 py-2", left < 0 && "text-critical")}>
            <span className={left < 0 ? "" : "text-ink-2"}>{left < 0 ? (owed > 0 ? "More than is free to move" : "More than is held") : "Stays in the bank, held on this fund"}</span>
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
    </>
  );
}

type ReturnRow = {
  key: string;
  donor: string;
  email: string | null;
  accountName: string;
  gifts: number;
  given: number;
  sharePct: number;
  owed: number;
  sent: number;
  remaining: number;
  method: "refund" | "payout";
  oldestGiftDays: number;
  blocker?: string;
};
type Returns = {
  enabled: boolean;
  status: "active" | "closing" | "closed";
  optedIn: number;
  refundWindowDays: number;
  base: { leftover: number; raised: number; at: string } | null;
  rows: ReturnRow[];
  remaining: number;
  sent: number;
  history: { id: string; donor: string; account: string; amount: number; method: "refund" | "payout"; status: string; live: boolean; error?: string; at: string; by: string }[];
};

const STATUS: Record<string, { label: string; tone: string }> = {
  completed: { label: "Done", tone: "text-good-ink" },
  sent: { label: "Sent, waiting for PayPal", tone: "text-ink-2" },
  unclaimed: { label: "Not claimed yet", tone: "text-warn-ink" },
  returned: { label: "Came back: owed again", tone: "text-warn-ink" },
  failed: { label: "Refused by PayPal", tone: "text-critical" },
};

/**
 * Donors who ticked "return my share of what's left" when they gave: what each
 * is owed (leftover × their share of everything raised, one line per donor and
 * PayPal account), and sending it as refunds or one payout.
 */
function DonorReturns({ fundId, stamp, onDone }: { fundId: string; stamp: unknown; onDone: () => void }) {
  const [prefer, setPrefer] = useState<"auto" | "payout">("auto");
  const { data, reload } = useJson<Returns>(`/api/funds/${fundId}/returns?prefer=${prefer}`);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => {
    void reload();
  }, [stamp, reload]);

  if (!data || (!data.rows.length && !data.history.length)) return null;
  const sendable = data.rows.filter((r) => r.remaining > 0 && !r.blocker);
  const toSend = sendable.reduce((a, r) => a + r.remaining, 0);
  const blocked = data.rows.filter((r) => r.remaining > 0 && r.blocker);
  const recent = data.rows.some((r) => r.remaining > 0 && r.oldestGiftDays < data.refundWindowDays);

  async function send() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ message: string; results: { status: string }[] }>(`/api/funds/${fundId}/returns`, { json: { action: "send", prefer } });
      setMsg({ text: r.message, bad: r.results.some((x) => x.status === "failed") });
      setConfirming(false);
      await reload();
      onDone();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Leftover back to donors who asked">
      <div className="space-y-4">
        <p className="text-sm text-ink-2 max-w-3xl">
          {data.optedIn} donor{data.optedIn === 1 ? "" : "s"} asked, when they gave, for their share of whatever is left. Each gets the leftover times their share of everything the fund raised
          {data.base && <> ({usd(data.base.leftover)} was left of {usd(data.base.raised)} raised when closing started)</>}, worked out once per donor however many gifts they made.
          Gifts under {data.refundWindowDays} days old are refunded; older ones go back as one PayPal payout to the donor.
          {!data.enabled && " New donors aren't offered this any more, but these donors still get their share."}
        </p>

        {recent && data.remaining > 0 && (
          <fieldset className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <legend className="sr-only">How to send</legend>
            <label className="inline-flex items-center gap-2"><input type="radio" name={`ret-${fundId}`} checked={prefer === "auto"} onChange={() => setPrefer("auto")} /> Refund recent gifts, pay out the rest</label>
            <label className="inline-flex items-center gap-2"><input type="radio" name={`ret-${fundId}`} checked={prefer === "payout"} onChange={() => setPrefer("payout")} /> One payout per donor</label>
          </fieldset>
        )}

        <div className="overflow-x-auto rounded-lg border border-line">
          <DataGrid
            rows={data.rows}
            rowId={(r) => r.key}
            minWidth={760}
            inCard={false}
            ariaLabel="What each donor gets back"
            cols={[
              { header: "Donor", flex: 1, minWidth: 200, wrap: true, value: (r) => r.donor, render: (r) => <div><div className="font-medium">{r.donor}</div><div className="text-xs text-muted">{r.email ?? "no PayPal email"} · {r.gifts} gift{r.gifts === 1 ? "" : "s"}</div></div> },
              { header: "PayPal account", width: 160, value: (r) => r.accountName, render: (r) => <span className="text-ink-2">{r.accountName}</span> },
              { header: "Gave", width: 105, align: "right", value: (r) => r.given, render: (r) => usd(r.given) },
              { header: "Share", width: 90, align: "right", value: (r) => r.sharePct, render: (r) => `${r.sharePct.toFixed(2)}%` },
              { header: "Owed", width: 105, align: "right", value: (r) => r.owed, render: (r) => usd(r.owed) },
              { header: "Sent", width: 105, align: "right", value: (r) => r.sent, render: (r) => (r.sent ? usd(r.sent) : "—") },
              {
                header: "To send",
                width: 190,
                wrap: true,
                value: (r) => r.remaining,
                render: (r) =>
                  r.remaining > 0 ? (
                    <div>
                      <span className="tnum font-semibold">{usd(r.remaining)}</span> <span className="text-xs text-ink-2">{r.method === "refund" ? "as refunds" : "as a payout"}</span>
                      {r.blocker && <div className="text-xs text-critical">{r.blocker}</div>}
                    </div>
                  ) : (
                    <span className="text-xs text-good-ink">All sent</span>
                  ),
              },
            ]}
          />
        </div>

        {msg && <div className={clsx("rounded-lg border p-3 text-sm", msg.bad ? "border-bad-line bg-bad-wash" : "border-brand-line bg-brand-wash")}>{msg.text}</div>}

        {toSend > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {confirming ? (
              <>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>Back</button>
                <button className="btn btn-danger" disabled={busy} onClick={send}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Yes, send {usd(toSend)} to {sendable.length} donor{sendable.length === 1 ? "" : "s"}
                </button>
                <span className="text-xs text-muted">The money leaves your PayPal account now. It can&apos;t be undone from ClearAid.</span>
              </>
            ) : (
              <button className="btn btn-primary" onClick={() => setConfirming(true)}><Undo2 className="h-4 w-4" /> Send {usd(toSend)} to {sendable.length} donor{sendable.length === 1 ? "" : "s"}…</button>
            )}
          </div>
        )}
        {blocked.length > 0 && <p className="text-xs text-ink-2">{blocked.length} donor{blocked.length === 1 ? "" : "s"} can&apos;t be paid automatically (see the list). Return their share by hand and record it under Record payment.</p>}

        {data.history.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-2">Sent so far ({data.history.length})</summary>
            <ul className="mt-2 divide-y divide-line">
              {data.history.map((h) => (
                <li key={h.id} className="py-2 flex flex-wrap items-baseline justify-between gap-2">
                  <span>{h.donor} <span className="text-xs text-muted">· {h.account} · {h.method === "refund" ? "refund" : "payout"}{h.live ? "" : " (simulated)"} · {new Date(h.at).toLocaleDateString()} by {h.by}</span></span>
                  <span className="text-right">
                    <span className="tnum font-medium">{usd(h.amount)}</span>{" "}
                    <span className={clsx("text-xs", STATUS[h.status]?.tone)}>{STATUS[h.status]?.label ?? h.status}</span>
                    {h.error && <span className="block text-xs text-critical">{h.error}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Section>
  );
}
