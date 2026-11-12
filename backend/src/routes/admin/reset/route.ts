import { ensureDemoEmbeds } from "@/lib/demo-embeds";
import { audit } from "@/lib/audit";
import { mutate, resetDb } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { actorOf, requireNgoAdmin } from "@/lib/session";

/**
 * Start again (admins only; disable with ALLOW_DEMO_RESET=false). {mode: "clean"}
 * keeps the NGO, logins, funds and payees but no transactions, for filling from
 * the PayPal and Plaid sandboxes; otherwise the demo scenario is restored.
 */
export const POST = handle(async (req: Request) => {
  if (process.env.ALLOW_DEMO_RESET === "false") return json({ error: "Reset disabled" }, 403);
  const me = await requireNgoAdmin();
  const b = (await req.json().catch(() => ({}))) as { mode?: string };
  const mode = b.mode === "clean" ? "clean" : "demo";
  resetDb(mode);
  ensureDemoEmbeds();
  mutate((db) => audit(db, { actor: actorOf(me), action: "demo.reset", summary: mode === "clean" ? "Reset to a clean start: the NGO, logins, funds and payees, with no transactions" : "Reset all data to the demo scenario" }));
  return json({ ok: true, mode });
});
