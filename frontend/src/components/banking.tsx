"use client";

import { useState } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { api } from "@/components/hooks";

/** Budget-category sub-codes understood after a dash, e.g. #RO1-MED. Must match SUBCODES in backend/src/lib/banking.ts. */
export const SUBCODE_HINT = [
  ["FOOD", "Food"],
  ["WAT", "Water"],
  ["SHL", "Shelter"],
  ["MED", "Medical"],
  ["HYG", "Hygiene"],
  ["LOG", "Logistics"],
  ["CASH", "Cash aid"],
  ["ADM", "Admin"],
] as const;

export function CodeChip({ code }: { code: string }) {
  return <span className="inline-flex items-center rounded-md border border-[#bfe3dc] bg-brand-wash px-1.5 py-0.5 font-mono text-[11px] font-semibold text-brand-ink">#{code}</span>;
}

/** Inline editor for a fund's tracking codes (admins). */
export function CodesEditor({ fundId, codes, editable, onSaved }: { fundId: string; codes: string[]; editable: boolean; onSaved: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(codes.join(", "));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ message: string }>(`/api/funds/${fundId}/codes`, { json: { codes: text.split(/[\s,]+/).map((c) => c.replace(/^#/, "")).filter(Boolean) } });
      setEditing(false);
      onSaved(r.message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        {codes.length ? codes.map((c) => <CodeChip key={c} code={c} />) : <span className="text-xs text-muted">None</span>}
        {editable && (
          <button
            className="p-1 rounded text-muted hover:text-ink hover:bg-[#efeee9]"
            onClick={() => {
              setText(codes.join(", "));
              setEditing(true);
            }}
            aria-label="Edit tracking codes"
            title="Edit tracking codes"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }
  return (
    <form
      className="min-w-[14rem]"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-1">
        <input autoFocus className="input !py-1 text-xs font-mono" value={text} onChange={(e) => setText(e.target.value.toUpperCase())} placeholder="RO1, ASHA" aria-label="Tracking codes, comma separated" />
        <button className="p-1.5 rounded text-brand hover:bg-brand-wash" disabled={busy} aria-label="Save codes">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}</button>
        <button type="button" className="p-1.5 rounded text-muted hover:bg-[#efeee9]" onClick={() => setEditing(false)} aria-label="Cancel"><X className="h-3.5 w-3.5" /></button>
      </div>
      {err ? <p className="text-[11px] text-critical mt-1" role="alert">{err}</p> : <p className="text-[11px] text-muted mt-1">Comma separated. Waiting bank lines are re-checked on save.</p>}
    </form>
  );
}
