import { EventEmitter } from "node:events";
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
}
