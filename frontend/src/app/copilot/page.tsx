"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Bot, ChevronDown, Loader2, Lock, MessageSquarePlus, Send, Trash2 } from "lucide-react";
import clsx from "clsx";
import { Page, useMe } from "@/components/AppShell";
import { api, useJson } from "@/components/hooks";

type Status = {
  model: string;
  power?: "awake" | "asleep" | "waking";
  modelStatus: { ok: boolean; error?: string };
  search: { ok: boolean; error?: string };
  lastSync: { at: string; ok: boolean; error?: string; docs: number } | null;
  audience: "staff" | "public";
  funds: { id: string; title: string }[];
  includesUntraced: boolean;
};
type Source = { n: number; id: string; fundTitle?: string; kind: string; date?: string; href?: string; text: string };
type ChatItem = { id: string; title: string; updatedAt: string; count: number };
type Reply = { reply: string; sources: Source[]; scope: { funds: { id: string; title: string }[]; narrowed: boolean }; search: "faiss" | "keyword"; model: string; chatId?: string };
type Msg = { role: "user" | "assistant"; text: string; reply?: Reply };

/** Bold (**x**) and [n] citations; plain text otherwise (no HTML from the model). */
function Rich({ text, sources }: { text: string; sources?: Source[] }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*|\[\d+\])/g).map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
        const cite = p.match(/^\[(\d+)\]$/);
        if (cite && sources?.some((s) => s.n === Number(cite[1]))) {
          return (
            <a key={i} href={`#src-${cite[1]}`} className="text-brand text-[0.8em] align-super font-semibold no-underline">
              {cite[1]}
            </a>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

export default function CopilotPage() {
  const { me } = useMe();
  const { data: status, reload: reloadStatus } = useJson<Status>("/api/copilot");
  const { data: chatList, reload: reloadChats } = useJson<{ chats: ChatItem[] }>("/api/copilot/chats");
  const [chatId, setChatId] = useState<string | null>(null);
  const [fundId, setFundId] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const donor = me.role === "donor";

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    setMsgs((m) => [...m, { role: "user", text: q }]);
    try {
      // Start the question, then check for the answer every 2 s: no request stays open while the model thinks.
      const { jobId } = await api<{ jobId: string }>("/api/copilot", { json: { message: q, fundId: fundId || undefined, chatId: chatId ?? undefined, async: true } });
      let r: Reply | null = null;
      for (let waited = 0; !r; waited += 2) {
        if (waited > 600) throw new Error("This is taking too long. Try again in a moment.");
        await new Promise((res) => setTimeout(res, 2000));
        const j = await api<{ status: "working" | "done" | "error"; result?: Reply; error?: string }>(`/api/copilot/jobs/${jobId}`);
        if (j.status === "error") throw new Error(j.error);
        if (j.status === "done") r = j.result!;
      }
      setMsgs((m) => [...m, { role: "assistant", text: r.reply, reply: r }]);
      if (r.chatId) setChatId(r.chatId);
      void reloadChats();
    } catch (e) {
      // Not answered (e.g. the AI is waking up): take the question back so it can be sent again.
      setMsgs((m) => m.slice(0, -1));
      setInput(q);
      setError((e as Error).message);
      void reloadStatus();
    } finally {
      setBusy(false);
    }
  }

  // While the AI starts up, check every few seconds so the banner clears when it's ready.
  const waking = status?.power === "waking";
  useEffect(() => {
    if (!waking) return;
    const t = setInterval(() => void reloadStatus(), 8000);
    return () => clearInterval(t);
  }, [waking, reloadStatus]);

  function newChat() {
    if (busy) return;
    setChatId(null);
    setMsgs([]);
    setError(null);
  }

  async function openChat(id: string) {
    if (busy || id === chatId) return;
    setError(null);
    try {
      const c = await api<{ id: string; messages: { role: "user" | "assistant"; text: string; reply?: Reply }[] }>(`/api/copilot/chats/${id}`);
      setChatId(c.id);
      setMsgs(c.messages.map((m) => ({ role: m.role, text: m.text, reply: m.reply })));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeChat(id: string) {
    if (busy) return;
    try {
      await api("/api/copilot/chats", { json: { action: "delete", id } });
      if (id === chatId) newChat();
      void reloadChats();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const first = status?.funds[0]?.title.split(/[—–:-]/)[0].trim();
  const suggestions = donor
    ? [first ? `Where has the ${first} money gone so far?` : "Where has the money gone so far?", "What was bought, and from which suppliers?", "How much is left, and what is it earmarked for?"]
    : [
        first ? `Where did the ${first} money come from and where did it go?` : "Where did the money come from and where did it go?",
        "Which payees were paid the most, and for what?",
        "List the payments that are still waiting for their bank line",
        "What bank money isn't on any fund yet?",
      ];

  const offline = status && !status.power && (!status.modelStatus.ok || !status.search.ok);

  return (
    <Page
      title="Copilot"
      subtitle={`Ask where money came from and where it went. Answers come from a local ${status?.model ?? "Llama"} model searching ClearAid's records with FAISS; nothing leaves this machine.`}
    >
      <div className="grid lg:grid-cols-[220px_minmax(0,1fr)_280px] gap-6">
        <nav className="card flex flex-col self-start lg:h-[600px]" aria-label="Your chats">
          <div className="p-3 border-b border-line">
            <button className="btn w-full justify-center" onClick={newChat} disabled={busy}>
              <MessageSquarePlus className="h-4 w-4" /> New chat
            </button>
          </div>
          <ul className="flex-1 overflow-y-auto p-2 space-y-0.5 max-h-48 lg:max-h-none">
            {chatList && !chatList.chats.length && <li className="px-2 py-3 text-xs text-muted">Your past chats will show up here.</li>}
            {chatList?.chats.map((c) => (
              <li key={c.id} className={clsx("group flex items-center rounded-lg", c.id === chatId ? "bg-hover-soft" : "hover:bg-hover-soft")}>
                <button className="flex-1 min-w-0 text-left px-2.5 py-2 text-sm truncate" onClick={() => void openChat(c.id)} title={c.title} aria-current={c.id === chatId}>
                  {c.title}
                </button>
                <button className="p-1.5 mr-1 text-muted hover:text-critical opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => void removeChat(c.id)} aria-label={`Delete chat: ${c.title}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <section className="card flex flex-col" style={{ height: 600 }}>
          <div className="px-4 py-3 border-b border-line flex flex-wrap items-center gap-2">
            <Bot className="h-4 w-4 text-brand" />
            <span className="font-semibold text-sm">Ask about</span>
            <div className="relative">
              <select className="input !py-1 !pr-7 text-sm appearance-none" value={fundId} onChange={(e) => setFundId(e.target.value)} aria-label="Fund to ask about">
                <option value="">{status?.funds.length === 1 ? status.funds[0].title : `All my funds${status ? ` (${status.funds.length})` : ""}`}</option>
                {status && status.funds.length > 1 && status.funds.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
              </select>
              <ChevronDown className="h-3.5 w-3.5 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-muted" />
            </div>
            <span className="text-xs text-muted ml-auto">Naming a fund in your question also narrows it.</span>
          </div>

          <div ref={box} className="flex-1 overflow-y-auto px-4 py-4 space-y-4 text-sm">
            {!msgs.length && (
              <div className="text-ink-2">
                <p>Try one of these:</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {suggestions.map((s) => (
                    <button key={s} className="rounded-full border border-line px-3 py-1.5 text-xs hover:border-brand text-left" onClick={() => void ask(s)} disabled={busy}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={clsx("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                <div className={clsx("max-w-[90%] rounded-2xl px-3.5 py-2.5", m.role === "user" ? "bg-brand text-white rounded-br-md" : "bg-hover-soft rounded-bl-md")}>
                  <div className="whitespace-pre-wrap">{m.role === "assistant" ? <Rich text={m.text} sources={m.reply?.sources} /> : m.text}</div>
                  {m.reply && m.reply.scope.funds.length > 0 && (
                    <div className="mt-2 text-xs text-muted">From {m.reply.scope.funds.map((f) => f.title).join(", ")}</div>
                  )}
                  {m.reply && m.reply.sources.length > 0 && (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer text-ink-2">{m.reply.sources.length} records used</summary>
                      <ol className="mt-1 space-y-1.5">
                        {m.reply.sources.map((s) => (
                          <li key={s.n} id={`src-${s.n}`} className="rounded-lg bg-surface border border-line p-2">
                            <div className="text-muted">
                              [{s.n}] {s.fundTitle ?? ""}{s.date ? ` · ${s.date}` : ""} · {s.kind}
                              {s.href && <> · <Link href={s.href} className="underline">open</Link></>}
                            </div>
                            <div className="text-ink-2 mt-0.5 line-clamp-3">{s.text}</div>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex items-center gap-2 text-muted text-xs">
                <Loader2 className="h-4 w-4 animate-spin" /> Searching the records and thinking…
              </div>
            )}
          </div>

          {error && <p className="px-4 pb-2 text-sm text-critical" role="alert">{error}</p>}
          <form
            className="border-t border-line p-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(input);
            }}
          >
            <input className="input flex-1" placeholder={donor ? "Ask where your funds' money went…" : "Ask about money in, money out, payees, receipts…"} value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} aria-label="Question" />
            <button className="btn btn-primary" disabled={busy || !input.trim()} aria-label="Send">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </form>
        </section>

        <aside className="space-y-4 self-start">
          {status?.power === "asleep" && (
            <div className="card p-4 text-xs">
              <div className="font-semibold">The AI is asleep</div>
              <p className="mt-1 text-ink-2">It switches off when nobody has used it for a while, to save cost. Ask a question and it wakes up; the first answer takes 1–2 minutes.</p>
            </div>
          )}
          {waking && (
            <div className="card p-4 text-xs">
              <div className="font-semibold flex items-center gap-1.5"><Loader2 className="h-4 w-4 animate-spin" /> The AI is waking up</div>
              <p className="mt-1 text-ink-2">Loading the model. Ask again in a minute or two; this page updates when it&apos;s ready.</p>
            </div>
          )}
          {offline && (
            <div className="card p-4 text-xs border-warn-line bg-warn-soft">
              <div className="font-semibold flex items-center gap-1.5 text-warn-ink"><AlertTriangle className="h-4 w-4" /> Copilot is partly offline</div>
              <ul className="mt-1.5 space-y-1 text-ink-2 list-disc pl-4">
                {!status!.modelStatus.ok && <li>{status!.modelStatus.error}</li>}
                {!status!.search.ok && <li>FAISS search isn&apos;t running (start it with <code>python rag/server.py</code>). Answers fall back to keyword search.</li>}
              </ul>
            </div>
          )}
          <div className="card p-4 text-sm">
            <h3 className="font-semibold flex items-center gap-1.5"><Lock className="h-4 w-4 text-brand" /> What it can see</h3>
            {!status ? (
              <div className="h-16 animate-pulse" />
            ) : (
              <>
                <ul className="mt-2 text-xs text-ink-2 space-y-0.5">
                  {status.funds.map((f) => <li key={f.id}>• {f.title}</li>)}
                  {status.includesUntraced && <li>• Bank lines not on any fund yet</li>}
                  {!status.funds.length && !status.includesUntraced && <li>No funds yet. Ask an admin for access.</li>}
                </ul>
                <p className="mt-2 text-xs text-muted">
                  {me.role === "admin"
                    ? "As an admin you can ask about every fund, in full detail."
                    : donor
                      ? "Only the funds an admin gave you, with the same private details hidden as on your screens."
                      : "Only the funds you're assigned to. Ask an admin to be added to others."}
                </p>
              </>
            )}
          </div>
        </aside>
      </div>
    </Page>
  );
}
