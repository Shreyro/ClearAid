import { EventEmitter } from "node:events";
import { config } from "./config";
import type { LedgerEntry } from "./types";

export type BusEvent =
  | { kind: "ledger"; fundId: string; entry: LedgerEntry }
  | { kind: "withdrawal"; fundId: string; withdrawalId: string; status: string }
  | { kind: "fund"; fundId: string }
  /** NGO staff or fund assignments changed. Carries no data; clients refetch. */
  | { kind: "team"; fundId?: string }
  /** Bank accounts, imports or tags changed. Carries no data; clients refetch. */
  | { kind: "bank"; fundId?: string };

const g = globalThis as unknown as { __clearaidBus?: EventEmitter };
export const bus: EventEmitter = (g.__clearaidBus ??= (() => {
  const e = new EventEmitter();
  e.setMaxListeners(500);
  return e;
})());

export function publish(ev: BusEvent) {
  bus.emit("event", ev);
  if (ev.kind === "ledger" && config.zapierWebhookUrl) {
    // Fire-and-forget fan-out (Zapier "Catch Hook", Make, n8n, Slack workflow…)
    fetch(config.zapierWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "clearaid",
        event: `ledger.${ev.entry.type}`,
        fundUrl: `${config.appUrl}/funds/${ev.fundId}`,
        ...ev.entry,
        amountUsd: (ev.entry.amount / 100).toFixed(2),
      }),
    }).catch(() => undefined);
  }
}
