"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, BadgeCheck, Bot, Camera, CheckCircle2, CircleDollarSign, EyeOff, FileText, Loader2, MapPin, RefreshCw, ScrollText, Users } from "lucide-react";
import { api, useJson, useLive, usd } from "@/components/hooks";
import { Meter, Pill, RiskBadge, Section, StatusIcon, StatusPill } from "@/components/ui";
import { CAT_LABEL, type WView } from "@/components/SpendCard";

type Sess = { session: { role: string; id?: string; name?: string } };

export function SpendDetail({ id }: { id: string }) {
  const { data: w, error, reload } = useJson<WView & { fundId: string }>(`/api/withdrawals/${id}`);
  const { data: sess } = useJson<Sess>("/api/session");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useLive(w?.fundId ?? null, (e) => {
    if (!e.withdrawalId || e.withdrawalId === id) void reload();
  });

  if (error) return <div className="mx-auto max-w-4xl px-4 py-16 text-center text-ink-2">{error}</div>;
  if (!w) return <div className="mx-auto max-w-4xl px-4 py-10"><div className="card h-64 animate-pulse" /></div>;

  const isNgo = sess?.session.role === "ngo";
  const a = w.audit;
  const ruleChecks = a?.checks.filter((c) => c.source === "rules") ?? [];
  const aiChecks = a?.checks.filter((c) => c.source === "ai") ?? [];
  const signed = w.approvals.filter((x) => x.decision === "approve").length;
  const findPhoto = (fileId: string) => a?.photos.find((p) => p.fileId === fileId);

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    setMsg(null);
    try {
      const r = await api<{ message: string }>(`/api/withdrawals/${id}/decision`, { json: { decision, note: note || undefined } });
      setMsg(r.message);
      setNote("");
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function reaudit() {
    setBusy("audit");
    try {
      await api(`/api/withdrawals/${id}/audit`, { method: "POST" });
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <Link href={`/funds/${w.fundSlug}`} className="text-sm text-ink-2 inline-flex items-center gap-1 hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> {w.fundTitle}
      </Link>

      <div className="card p-6 mt-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs text-muted font-mono">{w.id}</div>
            <h1 className="text-2xl font-semibold tracking-tight mt-1 flex items-center gap-2">
              {w.vendor?.name}
              {w.vendor?.verified && <BadgeCheck className="h-5 w-5 text-brand" aria-label="Verified vendor" />}
            </h1>
            <div className="text-sm text-ink-2 mt-1">{w.vendor?.location} · {CAT_LABEL[w.category]}</div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-semibold tnum">{usd(w.amount)}</div>
            <div className="flex gap-2 justify-end mt-1.5">
              <StatusPill status={w.status} />
              {a && <RiskBadge score={a.riskScore} verdict={a.verdict} />}
            </div>
          </div>
        </div>
        <p className="mt-5 text-[15px]">{w.purpose}</p>
        {w.piiFound.length > 0 && (
          <p className="text-xs text-ink-2 mt-2 flex items-center gap-1.5 flex-wrap">
            <EyeOff className="h-3.5 w-3.5" /> Personal data redacted before publishing:
            {w.piiFound.map((p) => <Pill key={p.type}>{p.count}× {p.type}</Pill>)}
          </p>
        )}
        {w.purposeRaw && w.purposeRaw !== w.purpose && (
          <div className="mt-3 rounded-lg bg-[#fff8e6] px-3 py-2 text-xs">
            <span className="font-semibold text-[#7a5200]">Original (visible to NGO and vendor only):</span> {w.purposeRaw}
          </div>
        )}
        <div className="flex flex-wrap gap-4 mt-4 text-sm text-ink-2">
          {w.need && <span>{w.quantity?.toLocaleString()} × {w.need.item} ({usd(Math.round(w.amount / (w.quantity || 1)))}/{w.need.unit.replace(/s$/, "")}, expected {usd(w.need.unitCost)})</span>}
          {w.location && <span className="inline-flex items-center gap-1"><MapPin className="h-4 w-4" />{w.location}</span>}
          {w.beneficiaries ? <span className="inline-flex items-center gap-1"><Users className="h-4 w-4" />{w.beneficiaries.toLocaleString()} people</span> : null}
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_300px] gap-6 mt-6">
        <div className="space-y-6 min-w-0">
          <Section
            title={<span className="flex items-center gap-2"><Bot className="h-4 w-4 text-brand" /> AI audit report</span>}
            action={
              a && (
                <Pill tone={a.engine === "claude" ? "brand" : "neutral"}>
                  {a.seeded ? "Sample audit (demo data)" : a.engine === "claude" ? `Claude · ${a.model}` : "Rules only (no AI key)"}
                </Pill>
              )
            }
          >
            {!a ? (
              <div className="flex items-center gap-2 text-sm text-ink-2"><Loader2 className="h-4 w-4 animate-spin" /> Claude is reading the receipt and checking the photos…</div>
            ) : (
              <>
                <div className="flex items-center gap-4">
                  <div className="w-40">
                    <div className="text-xs text-muted">Risk score</div>
                    <div className="text-2xl font-semibold tnum">{a.riskScore}<span className="text-sm text-muted">/100</span></div>
                    <Meter value={a.riskScore} max={100} color={a.riskScore <= 30 ? "var(--good)" : a.riskScore <= 60 ? "var(--warning)" : "var(--critical)"} />
                  </div>
                  <div className="flex-1">
                    <div className="text-xs text-muted">Recommendation</div>
                    <div className="font-semibold">{a.verdict === "approve" ? "Approve" : a.verdict === "reject" ? "Reject" : "Needs human review"}</div>
                    <p className="text-sm text-ink-2 mt-0.5">{a.summary}</p>
                  </div>
                </div>
                <div className="grid md:grid-cols-2 gap-5 mt-5">
                  <CheckList title="Rule checks (deterministic)" checks={ruleChecks} />
                  <CheckList title="AI findings" checks={aiChecks} />
                </div>
              </>
            )}
          </Section>

          {a?.receipt && (
            <Section title={<span className="flex items-center gap-2"><FileText className="h-4 w-4" /> Receipt, as read by the AI</span>}>
              <div className="flex flex-wrap gap-6 text-sm">
                <div><div className="text-xs text-muted">Vendor on receipt</div>{a.receipt.vendorName ?? "—"}</div>
                <div><div className="text-xs text-muted">Date</div>{a.receipt.date ?? "—"}</div>
                <div><div className="text-xs text-muted">Total</div><span className="tnum">{a.receipt.total != null ? `${a.receipt.currency ?? ""} ${a.receipt.total.toLocaleString()}` : "—"}</span></div>
                <div><div className="text-xs text-muted">Legible</div>{a.receipt.legible ? "Yes" : "No"}</div>
              </div>
              <table className="w-full text-sm mt-4">
                <thead><tr className="text-left text-xs text-muted border-b border-line"><th className="py-1.5 font-medium">Line item</th><th className="py-1.5 font-medium text-right">Qty</th><th className="py-1.5 font-medium text-right">Amount</th></tr></thead>
                <tbody>
                  {a.receipt.lineItems.map((li, i) => (
                    <tr key={i} className="border-b border-line last:border-0"><td className="py-1.5">{li.description}</td><td className="py-1.5 text-right tnum">{li.quantity?.toLocaleString() ?? "—"}</td><td className="py-1.5 text-right tnum">{li.amount?.toLocaleString() ?? "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          <Section title={<span className="flex items-center gap-2"><Camera className="h-4 w-4" /> Evidence</span>} action={w.hiddenFiles > 0 ? <Pill><EyeOff className="h-3 w-3" /> {w.hiddenFiles} private file{w.hiddenFiles > 1 ? "s" : ""}</Pill> : undefined}>
            {w.hiddenFiles > 0 && <p className="text-xs text-ink-2 mb-3">Some files show identifiable people or personal data, so only the NGO can see them. Their audit findings are still listed here.</p>}
            <div className="grid sm:grid-cols-2 gap-4">
              {w.receipts.map((r) => (
                <a key={r.id} href={r.url} target="_blank" rel="noreferrer" className="block rounded-xl border border-line overflow-hidden hover:border-line-strong">
                  {r.mime === "application/pdf" ? <div className="h-44 grid place-items-center bg-[#f7f7f3] text-sm text-ink-2"><FileText className="h-6 w-6" /> {r.name}</div> : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.url} alt="Receipt" className="h-44 w-full object-cover object-top bg-white" />
                  )}
                  <div className="px-3 py-2 text-xs text-ink-2 flex items-center gap-1"><ScrollText className="h-3.5 w-3.5" /> Receipt {!r.public && <Pill>private</Pill>}</div>
                </a>
              ))}
              {w.photos.map((p) => {
                const f = findPhoto(p.id);
                return (
                  <div key={p.id} className="rounded-xl border border-line overflow-hidden">
                    <a href={p.url} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.url} alt={f?.depicts ?? "Delivery photo"} className="h-44 w-full object-cover" />
                    </a>
                    <div className="px-3 py-2 text-xs space-y-1">
                      {f && (
                        <div className="flex items-start gap-1.5">
                          <StatusIcon status={f.matchesClaim && !f.concerns.length ? "pass" : f.matchesClaim ? "warn" : "fail"} className="h-3.5 w-3.5 mt-0.5" />
                          <span>{f.depicts}{f.concerns.length ? ` — ${f.concerns.join("; ")}` : ""}</span>
                        </div>
                      )}
                      <div className="text-muted">
                        {p.exif?.takenAt ? `Taken ${new Date(p.exif.takenAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "No capture time"}
                        {p.exif?.lat != null && p.exif?.lng != null && (
                          <> · <a className="underline" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${p.exif.lat}&mlon=${p.exif.lng}#map=13/${p.exif.lat}/${p.exif.lng}`}>{p.exif.lat.toFixed(3)}, {p.exif.lng.toFixed(3)}</a></>
                        )}
                        {p.exif?.device ? ` · ${p.exif.device}` : ""}
                        {!p.public && <> · <span className="font-semibold">private</span></>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        </div>

        <aside className="space-y-4 self-start lg:sticky lg:top-20">
          <section className="card p-5">
            <h2 className="font-semibold">Audit trail</h2>
            <ol className="mt-3 relative border-l border-line ml-1.5 space-y-4 text-sm">
              <Step done title="Request submitted" sub={new Date(w.createdAt).toLocaleString()} />
              <Step done={Boolean(a)} title="AI + rule audit" sub={a ? `Risk ${a.riskScore}/100 · ${a.verdict.replace("_", " ")}` : "In progress"} />
              {w.approvals.map((ap, i) => (
                <Step key={i} done title={`${ap.decision === "approve" ? "Approved" : "Rejected"} by ${ap.name}`} sub={`${new Date(ap.at).toLocaleString()}${ap.note ? ` · ${ap.note}` : ""}`} bad={ap.decision === "reject"} />
              ))}
              {w.status === "pending_approval" && <Step title={`Signatures: ${signed} of ${w.requiredApprovals}`} sub={w.requiredApprovals > 1 ? "Large withdrawals need two different NGO admins" : "One NGO admin must sign"} />}
              {w.payout && <Step done title="Paid via PayPal Payouts" sub={`${w.payout.batchId} · ${w.payout.status}${w.payout.live ? "" : " (simulated)"}`} />}
              {w.status === "paid" && <Step done title="Charged pro-rata to donors" sub={`${w.donorsCharged} donors' unspent balances`} />}
            </ol>
          </section>

          {isNgo && (w.status === "pending_approval" || w.status === "payout_failed") && (
            <section className="card p-5 border-brand">
              <h2 className="font-semibold">Your decision</h2>
              <p className="text-xs text-ink-2 mt-1">Signed in as {sess?.session.name}. Approval {signed + 1 >= w.requiredApprovals ? "releases the PayPal payout immediately" : "adds your signature; a second admin must co-sign"}.</p>
              <textarea className="input mt-3" rows={2} placeholder="Note (shown on the public ledger if rejected)" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="flex gap-2 mt-2">
                <button className="btn btn-primary flex-1" disabled={Boolean(busy)} onClick={() => decide("approve")}>
                  {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleDollarSign className="h-4 w-4" />} Approve
                </button>
                <button className="btn btn-danger" disabled={Boolean(busy)} onClick={() => decide("reject")}>Reject</button>
              </div>
              <button className="btn btn-ghost w-full mt-2 text-xs" disabled={Boolean(busy)} onClick={reaudit}>
                <RefreshCw className={`h-3.5 w-3.5 ${busy === "audit" ? "animate-spin" : ""}`} /> Re-run AI audit
              </button>
              {msg && <p className="text-sm mt-2">{msg}</p>}
            </section>
          )}
          {!isNgo && w.status === "pending_approval" && (
            <p className="text-xs text-muted px-1">Switch to an NGO admin persona (top right) to approve or reject this request.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function CheckList({ title, checks }: { title: string; checks: { id: string; label: string; status: string; detail: string }[] }) {
  return (
    <div>
      <div className="text-xs font-semibold text-muted mb-2">{title}</div>
      {checks.length === 0 ? <p className="text-sm text-muted">None</p> : (
        <ul className="space-y-2">
          {checks.map((c) => (
            <li key={c.id} className="flex gap-2 text-sm">
              <StatusIcon status={c.status} className="h-4 w-4 mt-0.5" />
              <div>
                <div className="font-medium">{c.label}</div>
                <div className="text-xs text-ink-2">{c.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Step({ title, sub, done, bad }: { title: string; sub: string; done?: boolean; bad?: boolean }) {
  return (
    <li className="pl-5 relative">
      <span className={`absolute -left-[7px] top-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface ${bad ? "bg-critical" : done ? "bg-brand" : "bg-line-strong"}`}>
        {done && !bad ? <CheckCircle2 className="hidden" /> : null}
      </span>
      <div className="font-medium">{title}</div>
      <div className="text-xs text-muted break-all">{sub}</div>
    </li>
  );
}
