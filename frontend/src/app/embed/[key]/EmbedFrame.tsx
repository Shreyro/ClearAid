"use client";

import { useEffect, useRef, useState } from "react";
import { EmbedView, type EmbedData } from "@/components/EmbedView";

type State = { data?: EmbedData; gone?: boolean; failed?: boolean };

async function fetchEmbed(key: string): Promise<State> {
  const res = await fetch(`/api/embed/${encodeURIComponent(key)}`, { cache: "no-store" });
  if (res.status === 404) return { gone: true };
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return { data: (await res.json()) as EmbedData };
}

const REFRESH_MS = 60_000;

/**
 * The page other websites show in an <iframe>. It needs no sign-in and reads
 * only the embed's public data. It keeps itself up to date, and tells the page
 * around it how tall it is (see public/embed.js) so the frame can fit it.
 */
export function EmbedFrame({ embedKey }: { embedKey: string }) {
  const [state, setState] = useState<State>({});
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchEmbed(embedKey).then(
        (next) => !cancelled && setState(next),
        // A failed refresh keeps the figures already on screen.
        () => !cancelled && setState((s) => (s.data ? s : { failed: true })),
      );
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [embedKey]);

  useEffect(() => {
    const el = root.current;
    if (!el || window.parent === window) return;
    // Only a number leaves the frame, so any parent page may receive it.
    const report = () => window.parent.postMessage({ type: "clearaid:embed:height", height: Math.ceil(el.getBoundingClientRect().height) }, "*");
    const watcher = new ResizeObserver(report);
    watcher.observe(el);
    report();
    return () => watcher.disconnect();
  }, []);

  return (
    <main ref={root} className="embed-root p-px">
      {state.data ? (
        <EmbedView data={state.data} />
      ) : state.gone || state.failed ? (
        <div className="card p-6 text-center text-sm text-ink-2" role="status">
          {state.gone ? "These figures are no longer published." : "These figures couldn't be loaded. Please try again later."}
        </div>
      ) : (
        <div className="card h-64 animate-pulse" aria-label="Loading" />
      )}
    </main>
  );
}
