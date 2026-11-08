"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bot, Check, Loader2, Send, ShieldAlert, Wrench, X } from "lucide-react";
import clsx from "clsx";
import { api } from "./hooks";

type Trace = { name: string; ok: boolean; summary: string };
type Turn = { conversationId: string; reply: string; trace: Trace[]; pending?: { name: string; input: unknown; description: string }[] };
type Msg = { role: "user" | "assistant"; text: string; trace?: Trace[]; pending?: Turn["pending"] };

/** Render a reply with withdrawal IDs turned into links; plain text only (no HTML injection). */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(wd_[a-f0-9]{12}|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^wd_[a-f0-9]{12}$/.test(p) ? (
          <Link key={i} href={`/spend/${p}`} className="font-mono text-[0.85em] text-brand underline">
            {p}
          </Link>
        ) : p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function Chat({ endpoint, title, subtitle, suggestions, placeholder, height = 380 }: { endpoint: string; title: string; subtitle: string; suggestions: string[]; placeholder: string; height?: number }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const convo = useRef<string | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  async function send(body: { message?: string; confirm?: boolean }) {
    setBusy(true);
    setError(null);
    if (body.message) setMsgs((m) => [...m, { role: "user", text: body.message! }]);
    try {
      const r = await api<Turn>(endpoint, { json: { ...body, conversationId: convo.current } });
      convo.current = r.conversationId;
      setMsgs((m) => [...m.map((x) => ({ ...x, pending: undefined })), { role: "assistant", text: r.reply, trace: r.trace, pending: r.pending }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const awaiting = msgs[msgs.length - 1]?.pending?.length;

  return (
    <section className="card flex flex-col overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-line">
        <h2 className="font-semibold flex items-center gap-2">
          <Bot className="h-4 w-4 text-brand" /> {title}
        </h2>
        <p className="text-xs text-ink-2 mt-0.5">{subtitle}</p>
      </div>
      <div ref={box} className="flex-1 overflow-y-auto px-5 py-4 space-y-3 text-sm" style={{ height }}>
        {!msgs.length && (
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button key={s} onClick={() => send({ message: s })} className="rounded-full border border-line px-3 py-1.5 text-xs hover:border-brand hover:text-brand-ink text-left">
                {s}
              </button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={clsx("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div className={clsx("max-w-[88%] rounded-2xl px-3.5 py-2.5 whitespace-pre-wrap", m.role === "user" ? "bg-brand text-white rounded-br-md" : "bg-[#f4f3ef] rounded-bl-md")}>
              {m.trace && m.trace.length > 0 && (
                <details className="mb-1.5 text-[11px] text-muted">
                  <summary className="cursor-pointer flex items-center gap-1"><Wrench className="h-3 w-3" /> {m.trace.length} tool call{m.trace.length > 1 ? "s" : ""}: {[...new Set(m.trace.map((t) => t.name))].join(", ")}</summary>
                  <ul className="mt-1 space-y-0.5 font-mono">
                    {m.trace.map((t, j) => (
                      <li key={j} className={t.ok ? "" : "text-critical"}>
                        {t.name} → {t.summary}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <Rich text={m.text} />
              {m.pending && m.pending.length > 0 && (
                <div className="mt-3 rounded-xl border border-[#f3d48a] bg-[#fffaf0] p-3">
                  <div className="text-xs font-semibold text-[#7a5200] flex items-center gap-1"><ShieldAlert className="h-3.5 w-3.5" /> Needs your confirmation</div>
                  {m.pending.map((p, j) => (
                    <div key={j} className="mt-2 text-xs">
                      <div className="font-semibold">{p.description}</div>
                      <pre className="mt-1 bg-white rounded-lg p-2 overflow-x-auto font-mono text-[11px]">{JSON.stringify(p.input, null, 2)}</pre>
                    </div>
                  ))}
                  <div className="flex gap-2 mt-3">
                    <button className="btn btn-primary !py-1.5 text-xs" disabled={busy} onClick={() => send({ confirm: true })}>
                      <Check className="h-3.5 w-3.5" /> Approve
                    </button>
                    <button className="btn btn-ghost !py-1.5 text-xs" disabled={busy} onClick={() => send({ confirm: false })}>
                      <X className="h-3.5 w-3.5" /> Decline
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking and checking the ledger…
          </div>
        )}
        {error && <div className="text-xs text-critical">{error}</div>}
      </div>
      <form
        className="border-t border-line p-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || busy || awaiting) return;
          void send({ message: input.trim() });
          setInput("");
        }}
      >
        <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder={awaiting ? "Approve or decline the pending action first" : placeholder} disabled={Boolean(awaiting)} />
        <button className="btn btn-primary !px-3" disabled={busy || !input.trim() || Boolean(awaiting)} aria-label="Send">
          <Send className="h-4 w-4" />
        </button>
      </form>
    </section>
  );
}
