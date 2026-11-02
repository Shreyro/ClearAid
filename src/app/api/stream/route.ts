import { bus, type BusEvent } from "@/lib/events";

export const dynamic = "force-dynamic";

/** Server-sent events: live ledger and audit updates for a fund (or all funds). */
export async function GET(req: Request) {
  const fund = new URL(req.url).searchParams.get("fund");
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const onEvent = (ev: BusEvent) => {
        if (!fund || ev.fundId === fund) send(ev);
      };
      bus.on("event", onEvent);
      const ping = setInterval(() => send({ kind: "ping" }), 25_000);
      cleanup = () => {
        bus.off("event", onEvent);
        clearInterval(ping);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      send({ kind: "hello" });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
