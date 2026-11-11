import { getDb } from "@/lib/db";
import { publicEmbedPayload } from "@/lib/embed";
import { type Ctx, handle } from "@/lib/http";

/**
 * Anyone may read a live embed, from any website: it is the public face of the
 * fund. There are no cookies involved, so any origin is allowed.
 */
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
};

// Each response re-checks the fund's hash chain, so answers are reused for a few seconds to keep a busy page cheap.
const FRESH_MS = 5_000;
const recent = new Map<string, { at: number; body: string }>();

/**
 * The public data for one embed (no sign-in): only the blocks its admin
 * switched on. A paused, deleted or unknown key gets the same 404.
 */
export const GET = handle(async (_req: Request, ctx: Ctx<{ key: string }>) => {
  const { key } = await ctx.params;
  const found = publicEmbedPayload(getDb(), key);
  if (!found) {
    return new Response(JSON.stringify({ error: "This embed isn't published" }), { status: 404, headers: HEADERS });
  }
  // Keyed by the settings' last change, so an edit shows up at once.
  const cacheKey = `${found.embed.id}:${found.embed.updatedAt}`;
  const hit = recent.get(cacheKey);
  if (hit && Date.now() - hit.at < FRESH_MS) return new Response(hit.body, { headers: HEADERS });
  const body = JSON.stringify(found.payload);
  if (recent.size > 500) recent.clear();
  recent.set(cacheKey, { at: Date.now(), body });
  return new Response(body, { headers: HEADERS });
});
