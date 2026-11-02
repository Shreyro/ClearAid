"use client";

import { useCallback, useEffect, useEffectEvent, useState } from "react";

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
    headers: init?.json !== undefined ? { "Content-Type": "application/json", ...init?.headers } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

/** Fetch JSON and keep the last good value while refetching (no flashes). */
export function useJson<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!url) return;
    try {
      const next = await api<T>(url);
      setData(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [url]);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    api<T>(url).then(
      (next) => {
        if (cancelled) return;
        setData(next);
        setError(null);
      },
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [url]);
  return { data, error, reload, setData };
}

export type LiveEvent = { kind: string; fundId?: string; entry?: { seq: number; type: string; amount: number; memo: string; actor: string; ts: string; hash: string }; withdrawalId?: string; status?: string };

/** Subscribe to the server-sent event stream (all funds, or one). */
export function useLive(fund: string | null | undefined, onEvent: (e: LiveEvent) => void) {
  const handle = useEffectEvent(onEvent);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (fund === null) return;
    const es = new EventSource(`/api/stream${fund ? `?fund=${encodeURIComponent(fund)}` : ""}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as LiveEvent;
        if (ev.kind !== "hello" && ev.kind !== "ping") handle(ev);
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [fund]);
  return connected;
}

export const usd = (cents: number, compact = false) => {
  const d = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact && Math.abs(d) >= 10000 ? "compact" : "standard",
    minimumFractionDigits: Number.isInteger(d) || compact ? 0 : 2,
    maximumFractionDigits: compact ? 1 : 2,
  }).format(d);
};

export const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
};

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
