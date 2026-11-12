"use client";

import { useState } from "react";
import { FileText, Loader2, Paperclip, Pencil, Plus, Tag, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { api, useJson, usd } from "./hooks";

export type TagRef = { id: string; name: string; color: string };
export type DocRef = { fileId: string; kind: "invoice" | "receipt" | "other"; name: string; url: string; byId: string; byName: string; at: string };

/** Tag colours (the server only accepts these names). */
const HEX: Record<string, string> = { teal: "#0f766e", indigo: "#4338ca", amber: "#b45309", rose: "#be123c", sky: "#0369a1", lime: "#4d7c0f", violet: "#6d28d9", slate: "#475569" };

export function TagChip({ tag, onRemove }: { tag: TagRef; onRemove?: () => void }) {
  const hex = HEX[tag.color] ?? HEX.slate;
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium border" style={{ color: hex, borderColor: `color-mix(in srgb, ${hex} 40%, transparent)`, background: `color-mix(in srgb, ${hex} 12%, transparent)` }}>
      {tag.name}
      {onRemove && <button type="button" onClick={onRemove} aria-label={`Remove the tag ${tag.name}`} className="opacity-70 hover:opacity-100"><X className="h-3 w-3" /></button>}
    </span>
  );
}

type Row = { id: string; ts: string; amount: number; direction: string; from: string; to: string; fundTitle: string; typeLabel: string; tags?: TagRef[]; docs?: DocRef[]; hasDocument?: boolean };

/**
 * One transaction's tags and documents, added after the fact. The ledger
 * entry itself never changes; every change is audit-logged.
 */
export function EntryPanel({ row, allTags, meId, isAdmin, onChanged, onClose }: { row: Row; allTags: TagRef[]; meId: string; isAdmin: boolean; onChanged: (message: string) => void; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newTag, setNewTag] = useState("");
  const [kind, setKind] = useState<DocRef["kind"]>("invoice");
  const tags = row.tags ?? [];
  const docs = row.docs ?? [];

  async function call(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setErr(null);
    try {
      const r = await api<{ message: string }>("/api/transactions/meta", { json: { key: row.id, ...body } });
      onChanged(r.message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const setTags = (ids: string[]) => call("tags", { action: "tags", tagIds: ids });

  async function createAndAdd() {
    const name = newTag.trim();
    if (!name) return;
    setBusy("new");
    setErr(null);
    try {
      const r = await api<{ tag: TagRef }>("/api/transactions/tags", { json: { action: "create", name } });
      setNewTag("");
      await setTags([...tags.map((t) => t.id), r.tag.id]);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }

  async function attach(file: File) {
    setBusy("upload");
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("read", "0");
      const res = await fetch("/api/payments/scan", { method: "POST", body: fd });
      const j = (await res.json().catch(() => ({}))) as { fileId?: string; error?: string };
      if (!res.ok || !j.fileId) throw new Error(j.error || "Upload failed");
      await call("upload", { action: "attach", fileId: j.fileId, kind });
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }

  const unused = allTags.filter((t) => !tags.some((x) => x.id === t.id));
  return (
    <section className="card p-4 mb-3 border-brand">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm">
          <div className="font-semibold">
            {row.amount ? `${row.amount > 0 ? "+" : "−"}${usd(Math.abs(row.amount))}` : row.typeLabel} · {row.direction === "in" ? row.from : row.to}
          </div>
          <div className="text-xs text-muted">{row.fundTitle} · {row.typeLabel} · {new Date(row.ts).toLocaleDateString()}</div>
        </div>
        <button type="button" className="p-1 text-muted hover:text-ink" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>
      </div>

      <div className="mt-3 grid md:grid-cols-2 gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted font-semibold mb-1.5 flex items-center gap-1"><Tag className="h-3.5 w-3.5" aria-hidden /> Tags</div>
          <div className="flex flex-wrap gap-1.5 min-h-6">
            {tags.length ? tags.map((t) => <TagChip key={t.id} tag={t} onRemove={() => void setTags(tags.filter((x) => x.id !== t.id).map((x) => x.id))} />) : <span className="text-xs text-muted">No tags yet.</span>}
          </div>
          {unused.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {unused.map((t) => (
                <button key={t.id} type="button" disabled={Boolean(busy)} onClick={() => void setTags([...tags.map((x) => x.id), t.id])} className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2 py-0.5 text-xs text-ink-2 hover:border-brand">
                  <Plus className="h-3 w-3" /> {t.name}
                </button>
              ))}
            </div>
          )}
          <form className="flex gap-2 mt-2" onSubmit={(e) => { e.preventDefault(); void createAndAdd(); }}>
            <input className="input !py-1 text-sm" value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="New tag, e.g. Boat hire" maxLength={40} aria-label="New tag name" />
            <button className="btn btn-ghost !py-1 text-xs shrink-0" disabled={Boolean(busy) || newTag.trim().length < 2}>{busy === "new" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Create and add</button>
          </form>
        </div>

        <div>
          <div className="text-xs uppercase tracking-wide text-muted font-semibold mb-1.5 flex items-center gap-1">
            <FileText className="h-3.5 w-3.5" aria-hidden /> Documents
            {row.direction === "out" && row.hasDocument === false && <span className="normal-case tracking-normal font-normal text-warn-ink">· no invoice or receipt yet</span>}
          </div>
          {docs.length ? (
            <ul className="space-y-1">
              {docs.map((d) => (
                <li key={d.fileId} className="flex items-center gap-2 text-sm">
                  <a href={d.url} target="_blank" rel="noreferrer" className="underline truncate">{d.name}</a>
                  <span className="text-xs text-muted shrink-0">{d.kind} · {d.byName}</span>
                  {(isAdmin || d.byId === meId) && (
                    <button type="button" className="ml-auto p-1 text-muted hover:text-critical" disabled={Boolean(busy)} onClick={() => void call(`rm:${d.fileId}`, { action: "detach", fileId: d.fileId })} aria-label={`Remove ${d.name}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">{row.hasDocument ? "Its receipt is on the payment or bank line it came from." : "None attached yet."}</p>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <select className="input !w-auto !py-1 text-sm" value={kind} onChange={(e) => setKind(e.target.value as DocRef["kind"])} aria-label="What kind of document">
              <option value="invoice">Invoice</option>
              <option value="receipt">Receipt</option>
              <option value="other">Other document</option>
            </select>
            <label className={clsx("btn btn-ghost !py-1 text-xs cursor-pointer", busy === "upload" && "opacity-60 pointer-events-none")}>
              {busy === "upload" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />} Attach an image or PDF
              <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void attach(f); }} />
            </label>
          </div>
        </div>
      </div>
      {err && <p className="text-sm text-critical mt-2" role="alert">{err}</p>}
      <p className="text-xs text-muted mt-3">Tags and documents are for your team only: donors and embeds never see them. Each change is in the audit log.</p>
    </section>
  );
}

/** Rename, recolour or delete tags (the person who made one, or an admin). */
export function TagManager({ onChanged }: { onChanged: (message: string) => void }) {
  const { data, reload } = useJson<{ tags: (TagRef & { uses: number; createdByName: string; mine: boolean })[]; colors: string[] }>("/api/transactions/tags");
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function post(body: Record<string, unknown>) {
    setErr(null);
    try {
      const r = await api<{ message: string }>("/api/transactions/tags", { json: body });
      setEditing(null);
      await reload();
      onChanged(r.message);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <section className="card p-4 mb-3">
      <h2 className="font-semibold text-sm">Transaction tags</h2>
      <p className="text-xs text-ink-2 mt-0.5">Your own categories for transactions. Anyone on the team can create them on a transaction; the person who made a tag, or an admin, can change or delete it.</p>
      {!data ? <Loader2 className="h-4 w-4 animate-spin text-muted mt-3" /> : !data.tags.length ? <p className="text-sm text-muted mt-3">No tags yet. Click a transaction to add the first one.</p> : (
        <ul className="mt-3 divide-y divide-line">
          {data.tags.map((t) => (
            <li key={t.id} className="py-2 flex flex-wrap items-center gap-2 text-sm">
              {editing === t.id ? (
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void post({ action: "update", id: t.id, name }); }}>
                  <input className="input !py-1 text-sm" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label="Tag name" autoFocus />
                  <button className="btn btn-primary !py-1 text-xs">Save</button>
                  <button type="button" className="btn btn-ghost !py-1 text-xs" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : (
                <TagChip tag={t} />
              )}
              <span className="text-xs text-muted">{t.uses} transaction{t.uses === 1 ? "" : "s"} · by {t.createdByName}</span>
              {editing !== t.id && (
                <span className="ml-auto flex items-center gap-1">
                  <select className="input !w-auto !py-0.5 text-xs" value={t.color} onChange={(e) => void post({ action: "update", id: t.id, color: e.target.value })} aria-label={`Colour of ${t.name}`}>
                    {data.colors.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <button type="button" className="p-1 text-muted hover:text-ink" onClick={() => { setEditing(t.id); setName(t.name); }} aria-label={`Rename ${t.name}`}><Pencil className="h-3.5 w-3.5" /></button>
                  <button type="button" className="p-1 text-muted hover:text-critical" onClick={() => void post({ action: "delete", id: t.id })} aria-label={`Delete ${t.name}`}><Trash2 className="h-3.5 w-3.5" /></button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {err && <p className="text-sm text-critical mt-2" role="alert">{err}</p>}
    </section>
  );
}
