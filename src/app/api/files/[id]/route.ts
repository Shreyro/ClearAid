import fs from "node:fs";
import path from "node:path";
import { getDb, uploadsDir } from "@/lib/db";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: RouteContext<"/api/files/[id]">) {
  const { id } = await ctx.params;
  const db = getDb();
  const f = db.files.find((x) => x.id === id);
  if (!f || !/^file_[a-z0-9]+$/.test(id)) return new Response("Not found", { status: 404 });
  if (!f.public) {
    const s = await getSession();
    const owner = db.withdrawals.find((w) => w.receiptFileIds.includes(id) || w.photoFileIds.includes(id));
    const ok = s.role === "ngo" || (s.role === "vendor" && owner?.vendorId === s.id);
    if (!ok) return new Response("This file is private to protect the people in it", { status: 403 });
  }
  const p = path.join(uploadsDir(), f.id);
  if (!fs.existsSync(p)) return new Response("Not found", { status: 404 });
  return new Response(fs.readFileSync(p), {
    headers: {
      "Content-Type": f.mime,
      "Cache-Control": f.public ? "public, max-age=3600" : "private, no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
