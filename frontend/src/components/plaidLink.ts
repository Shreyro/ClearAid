"use client";

import { api } from "./hooks";

/**
 * Opening Plaid Link, for a new bank or to log in to a connected one again
 * ("update" mode). Banks that log in on their own website (OAuth) send the
 * person to /oauth/plaid afterwards; Link has to be reopened there with the
 * same token, so the token and what it was for are kept in localStorage while
 * Link is open.
 */

type LinkFor = { mode: "new" } | { mode: "update"; accountId: string };
type Saved = LinkFor & { token: string; at: number };

declare global {
  interface Window {
    Plaid?: {
      create: (o: {
        token: string;
        receivedRedirectUri?: string;
        onSuccess: (publicToken: string, meta: { institution?: { name?: string } | null }) => void;
        onExit?: (err: { error_message?: string; display_message?: string } | null) => void;
      }) => { open: () => void };
    };
  }
}

const KEY = "clearaid:plaid-link";
const MAX_AGE = 30 * 60_000;

export function loadPlaidScript() {
  return new Promise<void>((resolve, reject) => {
    if (window.Plaid) return resolve();
    const s = document.createElement("script");
    s.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load Plaid Link"));
    document.head.appendChild(s);
  });
}

function remember(v: Saved | null) {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: OAuth banks then need starting again, nothing else breaks */
  }
}

/** The Link session a bank's website sent the person back to, if it's recent. */
export function pendingLink(): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Saved | null;
    return v && Date.now() - v.at < MAX_AGE ? v : null;
  } catch {
    return null;
  }
}

/** What to do once the person finished in Link. Returns the message to show. */
async function finish(f: LinkFor, publicToken: string, institution?: string) {
  if (f.mode === "update") return (await api<{ message: string }>("/api/bank/plaid", { json: { action: "reconnected", accountId: f.accountId } })).message;
  const r = await api<{ accounts: { name: string }[] }>("/api/bank/plaid", { json: { action: "exchange", publicToken, institution } });
  return `Connected ${r.accounts.length} account${r.accounts.length === 1 ? "" : "s"}: ${r.accounts.map((a) => a.name).join(", ")}. Its history is being prepared by Plaid; it arrives on its own (or press Sync).`;
}

function run(token: string, f: LinkFor, receivedRedirectUri?: string) {
  return new Promise<string | undefined>((resolve, reject) => {
    window.Plaid!.create({
      token,
      ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
      onSuccess: (publicToken, meta) => {
        remember(null);
        finish(f, publicToken, meta.institution?.name ?? undefined).then(resolve, reject);
      },
      onExit: (err) => {
        remember(null);
        if (err) reject(new Error(err.display_message || err.error_message || "Plaid Link closed with an error"));
        else resolve(undefined);
      },
    }).open();
  });
}

/** Start Link: a new bank, or (with accountId) logging in to a connected one again. */
export async function openPlaidLink(f: LinkFor) {
  const { linkToken } = await api<{ linkToken: string }>("/api/bank/plaid", { json: { action: "link_token", ...(f.mode === "update" ? { accountId: f.accountId } : {}) } });
  await loadPlaidScript();
  remember({ ...f, token: linkToken, at: Date.now() });
  return run(linkToken, f);
}

/** On /oauth/plaid: carry on with the Link session the bank's website sent the person back from. */
export async function resumePlaidLink() {
  const saved = pendingLink();
  if (!saved) throw new Error("This bank connection has expired or was started in another browser. Start again from Sources.");
  await loadPlaidScript();
  const f: LinkFor = saved.mode === "update" ? { mode: "update", accountId: saved.accountId } : { mode: "new" };
  return run(saved.token, f, window.location.href);
}
