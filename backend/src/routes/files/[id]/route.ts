import fs from "node:fs";
import path from "node:path";
import { getDb, uploadsDir } from "@/lib/db";
import type { Ctx } from "@/lib/http";
import { canSeeTxn } from "@/lib/banking";
import { getSession, ngoCanSeeFund, ngoMember } from "@/lib/session";

export async function GET(_req: Request, ctx: Ctx<{ id: string }>) {
  const { id } = await ctx.params;
  const db = getDb();
  const f = db.files.find((x) => x.id === id);
  if (!f || !/^file_[a-z0-9]+$/.test(id)) return new Response("Not found", { status: 404 });
  if (!f.public) {
    const s = await getSession();
    const owner = db.withdrawals.find((w) => w.receiptFileIds.includes(id) || w.photoFileIds.includes(id));
    const fund = owner && db.funds.find((x) => x.id === owner.fundId);
    const member = s.role === "ngo" ? ngoMember(s.id) : undefined;
    const bankLine = db.bankTxns.find((t) => t.receipts?.some((r) => r.fileId === id));
    const bankOk = Boolean(bankLine && member && db.bankAccounts.some((a) => a.id === bankLine.accountId && a.ngoId === member.ngoId) && canSeeTxn(bankLine, member, db));
    const ok = Boolean(fund && ngoCanSeeFund(s, fund)) || bankOk;
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
