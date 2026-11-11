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
    const bankOk = Boolean(bankLine && member && member.role !== "donor" && db.bankAccounts.some((a) => a.id === bankLine.accountId && a.ngoId === member.ngoId) && canSeeTxn(bankLine, member, db));
    // A receipt behind a declared payment: admins, or staff assigned to that fund (never donors).
    const payment = db.payments?.find((p) => p.receipt?.fileId === id);
    const payFund = payment && db.funds.find((x) => x.id === payment.fundId);
    const paymentOk = Boolean(payFund && ngoCanSeeFund(s, payFund));
    // A receipt just scanned and not yet recorded: anyone on staff of the NGO (they see the preview while filling in the form).
    const scannedOnly = !owner && !bankLine && !payment && Boolean(member && member.role !== "donor" && f.scan?.ngoId === member.ngoId);
    const ok = Boolean(fund && ngoCanSeeFund(s, fund)) || bankOk || paymentOk || scannedOnly;
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
