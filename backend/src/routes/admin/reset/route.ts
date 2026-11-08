import { audit } from "@/lib/audit";
import { mutate, resetDb } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { actorOf, requireNgoAdmin } from "@/lib/session";

/** Restore the demo scenario (admins only; disable with ALLOW_DEMO_RESET=false). */
export const POST = handle(async () => {
  if (process.env.ALLOW_DEMO_RESET === "false") return json({ error: "Reset disabled" }, 403);
  const me = await requireNgoAdmin();
  resetDb();
  mutate((db) => audit(db, { actor: actorOf(me), action: "demo.reset", summary: "Reset all data to the demo scenario" }));
  return json({ ok: true });
});
