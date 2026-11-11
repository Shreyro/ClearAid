"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CodeXml, Copy, ExternalLink, EyeOff, Loader2, Pause, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { api, useJson } from "./hooks";
import { EmbedView, type EmbedData } from "./EmbedView";
import { Pill } from "./ui";

/** EmbedPublish in backend/src/lib/types.ts. */
type Publish = {
  totals: boolean;
  sources: boolean;
  categories: boolean;
  payees: "off" | "registered" | "all";
  flow: boolean;
  timeline: boolean;
  activity: 0 | 5 | 10 | 25;
  integrity: boolean;
};
type Embed = {
  id: string;
  key: string;
  name: string;
  fundId: string;
  fundTitle: string;
  publish: Publish;
  blocks: string[];
  enabled: boolean;
  updatedAt: string;
  updatedByName: string;
};
type Fund = { id: string; title: string; status: string };
type Resp = { embeds: Embed[]; funds: Fund[] };
type Draft = { id?: string; fundId: string; name: string; publish: Publish };

/** What a new embed starts with: the headline numbers and nothing that names anyone. */
const START: Publish = { totals: true, sources: true, categories: true, payees: "off", flow: false, timeline: false, activity: 0, integrity: true };

type Switch = "totals" | "sources" | "categories" | "flow" | "timeline" | "integrity";
const SWITCHES: Record<Switch, { label: string; hint: string }> = {
  totals: { label: "Totals", hint: "Money in, money out, money returned and what is still held." },
  sources: { label: "Where the money came from", hint: "A total per channel: PayPal donations, bank transfers, receipts recorded by staff. Never who gave." },
  categories: { label: "What it was spent on", hint: "A total per budget category (food, shelter, medical…) and bank fees." },
  flow: { label: "Money flow diagram", hint: "Channels → fund → categories in one picture. It shows the same totals as the two options above." },
  timeline: { label: "Money in and out over time", hint: "A chart of the running totals, one point per day." },
  integrity: { label: "Ledger integrity proof", hint: "How many entries the ledger has, whether its hash chain verifies, and the latest hash." },
};

const NEVER = "Never published, whatever you choose: who gave, bank references, account names, tracking codes, staff names, approvals, receipts and the audit log.";

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The HTML an NGO pastes into its own website. */
function embedCode(origin: string, e: Embed, height: number, fit: boolean) {
  const frame = `<iframe${fit ? " data-clearaid-embed" : ""} src="${origin}/embed/${e.key}" title="${attr(e.fundTitle)}: where the money goes" loading="lazy" style="width:100%;max-width:760px;height:${height}px;border:0"></iframe>`;
  return fit ? `${frame}\n<script async src="${origin}/embed.js"></script>` : frame;
}

/**
 * Settings → Public embeds (admins). Choose what a fund shows to the public,
 * see exactly that before publishing, then copy an <iframe> into any website.
 */
export function Embeds() {
  const { data, reload } = useJson<Resp>("/api/embeds");
  // The fund page links here with ?fund=<id> to start an embed for that fund.
  const [draft, setDraft] = useState<Draft | null>(() => {
    const fundId = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("fund");
    return fundId ? { fundId, name: "", publish: START } : null;
  });
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function act(action: "pause" | "resume" | "delete", e: Embed) {
    if (action === "delete" && !window.confirm(`Delete "${e.name}"? Its link stops working on every website that uses it. This can't be undone; pause it instead if you may want it back.`)) return;
    setBusy(e.id);
    setMsg(null);
    try {
      const r = await api<{ message: string }>("/api/embeds", { json: { action, id: e.id } });
      setMsg({ ok: true, text: r.message });
      if (action === "delete" && codeFor === e.id) setCodeFor(null);
      await reload();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <div className="card p-6"><Loader2 className="h-5 w-5 animate-spin text-muted" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h2 className="text-lg font-semibold">Public embeds</h2>
          <p className="text-sm text-ink-2 mt-1">
            Show a fund&apos;s numbers on your own website. You choose what each embed publishes and see exactly that before it goes live; it then stays up to date by itself. Anyone with an embed&apos;s link can see what it shows, so publish only what you&apos;re happy for the public to read.
          </p>
        </div>
        {!draft && (
          <button className="btn btn-primary" onClick={() => setDraft({ fundId: data.funds[0]?.id ?? "", name: "", publish: START })} disabled={!data.funds.length}>
            <Plus className="h-4 w-4" /> New embed
          </button>
        )}
      </div>

      {msg && <div className={clsx("card p-3 text-sm", msg.ok ? "bg-brand-wash border-[#bfe3dc]" : "bg-[#fdf2f2] border-[#f1c4c4] text-[#9b2424]")} role={msg.ok ? "status" : "alert"}>{msg.text}</div>}

      {draft && (
        <Editor
          key={draft.id ?? "new"}
          draft={draft}
          funds={data.funds}
          onCancel={() => setDraft(null)}
          onSaved={async (saved, message) => {
            setDraft(null);
            setMsg({ ok: true, text: message });
            setCodeFor(saved.id);
            await reload();
          }}
        />
      )}

      {data.embeds.length === 0 && !draft ? (
        <div className="card p-8 text-center text-sm text-ink-2">
          <EyeOff className="h-5 w-5 mx-auto text-muted mb-2" aria-hidden />
          Nothing is published. Until you create an embed, no fund data is visible outside ClearAid apart from each fund&apos;s donation link.
        </div>
      ) : (
        <ul className="space-y-3">
          {data.embeds.map((e) => (
            <li key={e.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{e.name}</span>
                    <Pill tone={e.enabled ? "good" : "neutral"}>{e.enabled ? "Live" : "Paused"}</Pill>
                  </div>
                  <div className="text-sm text-ink-2 mt-0.5">{e.fundTitle}</div>
                  <div className="text-xs text-ink-2 mt-2"><span className="text-muted">Shows:</span> {e.blocks.join(" · ")}</div>
                  <div className="text-xs text-muted mt-1">Last changed by {e.updatedByName} on {shortDate(e.updatedAt)}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-ghost !py-1 text-xs" onClick={() => setCodeFor(codeFor === e.id ? null : e.id)} aria-expanded={codeFor === e.id}>
                    <CodeXml className="h-3.5 w-3.5" /> {codeFor === e.id ? "Hide code" : "Get code"}
                  </button>
                  <button className="btn btn-ghost !py-1 text-xs" onClick={() => setDraft({ id: e.id, fundId: e.fundId, name: e.name, publish: e.publish })}>
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button className="btn btn-ghost !py-1 text-xs" disabled={busy === e.id} onClick={() => act(e.enabled ? "pause" : "resume", e)}>
                    {e.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />} {e.enabled ? "Pause" : "Resume"}
                  </button>
                  <button className="btn btn-danger !py-1 text-xs" disabled={busy === e.id} onClick={() => act("delete", e)}>
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                </div>
              </div>
              {codeFor === e.id && <CodePanel embed={e} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Create or change an embed, with a live preview of exactly what it would publish. */
function Editor({ draft, funds, onCancel, onSaved }: { draft: Draft; funds: Fund[]; onCancel: () => void; onSaved: (e: Embed, message: string) => Promise<void> }) {
  const [fundId, setFundId] = useState(funds.some((f) => f.id === draft.fundId) ? draft.fundId : (funds[0]?.id ?? ""));
  const [name, setName] = useState(draft.name);
  const [publish, setPublish] = useState<Publish>(draft.publish);
  const [preview, setPreview] = useState<EmbedData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof Publish>(k: K, v: Publish[K]) => setPublish((p) => ({ ...p, [k]: v }));
  const nothing = !publish.totals && !publish.sources && !publish.categories && publish.payees === "off" && !publish.flow && !publish.timeline && !publish.activity && !publish.integrity;

  // The preview comes from the server, built by the same code as the public response.
  const settings = JSON.stringify(publish);
  useEffect(() => {
    if (!fundId) return;
    let cancelled = false;
    const t = setTimeout(() => {
      api<EmbedData>("/api/embeds/preview", { json: { fundId, publish: JSON.parse(settings) } }).then(
        (d) => !cancelled && setPreview(d),
        (e: Error) => !cancelled && setErr(e.message),
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [fundId, settings]);

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ embed: Embed; message: string }>("/api/embeds", { json: draft.id ? { action: "update", id: draft.id, name, publish } : { action: "create", fundId, name, publish } });
      await onSaved(r.embed, r.message);
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  }

  const check = (k: Switch) => (
    <label key={k} className="flex items-start gap-2.5">
      <input type="checkbox" className="mt-1" checked={publish[k]} onChange={(e) => set(k, e.target.checked)} />
      <span>
        <span className="text-sm font-medium">{SWITCHES[k].label}</span>
        <span className="block text-xs text-ink-2">{SWITCHES[k].hint}</span>
      </span>
    </label>
  );

  return (
    <form onSubmit={save} className="card p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <h3 className="font-semibold">{draft.id ? "Change what this embed shows" : "New embed"}</h3>
        <button type="button" className="p-1.5 rounded-lg text-muted hover:text-ink hover:bg-[#efeee9]" onClick={onCancel} aria-label="Close"><X className="h-4 w-4" /></button>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="emb-fund">Fund</label>
            <select id="emb-fund" className="input" value={fundId} onChange={(e) => setFundId(e.target.value)} disabled={Boolean(draft.id)} required>
              {funds.map((f) => <option key={f.id} value={f.id}>{f.title}{f.status !== "active" ? ` (${f.status})` : ""}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="emb-name">Name, for your own reference</label>
            <input id="emb-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Website home page" />
          </div>

          <fieldset className="space-y-3">
            <legend className="label">What to publish</legend>
            {check("totals")}
            {check("sources")}
            {check("categories")}
            <div>
              <label className="text-sm font-medium" htmlFor="emb-payees">Who was paid</label>
              <select id="emb-payees" className="input mt-1" value={publish.payees} onChange={(e) => set("payees", e.target.value as Publish["payees"])}>
                <option value="off">Don&apos;t show payees</option>
                <option value="registered">Name registered payees only</option>
                <option value="all">Name every payee</option>
              </select>
              <span className="block text-xs text-ink-2 mt-1">
                {publish.payees === "off" && "No payee is named anywhere in the embed."}
                {publish.payees === "registered" && "Only payees registered under Settings → Payees are named, with their totals. Everyone else is added up as “Other payees”."}
                {publish.payees === "all" && "Every payee is named as written on the ledger, which for bank payments is the statement's own wording. Private individuals appear as an alias (Person-XXXXXX). Check the preview."}
              </span>
            </div>
            {check("flow")}
            {check("timeline")}
            <div>
              <label className="text-sm font-medium" htmlFor="emb-activity">Latest movements</label>
              <select id="emb-activity" className="input mt-1" value={publish.activity} onChange={(e) => set("activity", Number(e.target.value) as Publish["activity"])}>
                <option value={0}>Don&apos;t list movements</option>
                <option value={5}>List the latest 5</option>
                <option value={10}>List the latest 10</option>
                <option value={25}>List the latest 25</option>
              </select>
              <span className="block text-xs text-ink-2 mt-1">Each with its date, type, budget category and amount. The payee is added only if payees are named above.</span>
            </div>
            {check("integrity")}
          </fieldset>

          <p className="text-xs text-muted flex items-start gap-1.5"><EyeOff className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden /> {NEVER}</p>

          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" disabled={busy || nothing || !fundId}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} {draft.id ? "Save changes" : "Publish"}</button>
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          </div>
          {nothing && <p className="text-sm text-ink-2">Choose at least one thing to publish.</p>}
          {err && <p className="text-sm text-critical" role="alert">{err}</p>}
        </div>

        <div className="min-w-0">
          <div className="label">Preview: exactly what the public will see</div>
          <div className="rounded-xl border border-dashed border-line-strong bg-[#fafaf7] p-3">
            {preview ? <EmbedView data={preview} /> : <div className="card h-64 animate-pulse" />}
          </div>
          <p className="text-xs text-muted mt-2">{draft.id ? "Nothing changes on your website until you save." : "Nothing is public until you publish."} The numbers are live from the ledger.</p>
        </div>
      </div>
    </form>
  );
}

/** The live embed and the code to paste into a website. */
function CodePanel({ embed }: { embed: Embed }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(640);
  const [fit, setFit] = useState(true);
  const [copied, setCopied] = useState(false);
  const origin = window.location.origin;

  // The embed reports its own height (the same message public/embed.js listens for).
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; height?: number } | null;
      if (ev.origin === window.location.origin && ev.source === frame.current?.contentWindow && d?.type === "clearaid:embed:height" && Number(d.height) > 0) setHeight(Math.ceil(Number(d.height) / 10) * 10);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const code = embedCode(origin, embed, height, fit);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the code is selectable instead */
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-4 space-y-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="min-w-0">
          <label className="label" htmlFor={`code-${embed.id}`}>Paste this where the figures should appear</label>
          <textarea id={`code-${embed.id}`} readOnly className="input font-mono !text-xs leading-relaxed resize-y" rows={fit ? 6 : 4} value={code} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
          <div className="flex flex-wrap gap-2 mt-2">
            <button type="button" className="btn btn-primary !py-1.5 text-xs" onClick={copy}>{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy code"}</button>
            <a className="btn btn-ghost !py-1.5 text-xs" href={`/embed/${embed.key}`} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /> Open on its own</a>
          </div>
        </div>
        <div className="min-w-0 space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={fit} onChange={(e) => setFit(e.target.checked)} />
            <span>
              Fit the height automatically
              <span className="block text-xs text-ink-2">Adds one small script that resizes the frame as the figures grow. Without it the frame stays {height}px tall and scrolls if it needs to.</span>
            </span>
          </label>
          <p className="text-xs text-muted">
            Works in any site builder that accepts HTML. Building your own page instead? The same figures are available as JSON at <a className="underline" href={`/api/embed/${embed.key}`} target="_blank" rel="noreferrer">/api/embed/{embed.key.slice(0, 6)}…</a>
          </p>
          {!embed.enabled && <p className="text-xs text-ink-2">This embed is paused, so websites using it show a notice instead of your figures.</p>}
        </div>
      </div>
      <div className="min-w-0">
        <div className="label">On your website it looks like this</div>
        <div className="rounded-xl border border-dashed border-line-strong bg-[#fafaf7] p-3">
          {/* Same width limit as the pasted code. Reloads when the settings change. */}
          <iframe ref={frame} key={embed.updatedAt} src={`/embed/${embed.key}`} title={`${embed.fundTitle}: where the money goes`} style={{ width: "100%", maxWidth: 760, height, border: 0, display: "block" }} />
        </div>
      </div>
    </div>
  );
}
