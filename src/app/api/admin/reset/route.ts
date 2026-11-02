import { resetDb } from "@/lib/db";
import { handle, json } from "@/lib/http";

/** Restore the demo scenario (disable with ALLOW_DEMO_RESET=false). */
export const POST = handle(async () => {
  if (process.env.ALLOW_DEMO_RESET === "false") return json({ error: "Reset disabled" }, 403);
  resetDb();
  return json({ ok: true });
});
