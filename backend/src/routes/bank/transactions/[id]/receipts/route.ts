import fs from "node:fs";
import path from "node:path";
import { scanReceipt } from "@/lib/ai/receipt";
import { audit } from "@/lib/audit";
import { canSeeTxn, scoreReceipt, txnView } from "@/lib/banking";
import { getDb, mutate, nowIso, uploadsDir, withLock } from "@/lib/db";
import { type Ctx, handle, json } from "@/lib/http";
import { fmt } from "@/lib/money";
import { actorOf, HttpError, requireNgo } from "@/lib/session";
import type { BankReceipt } from "@/lib/types";
import { saveUpload } from "@/lib/uploads";
import { announce } from "../../../shared";

/**
 * Attach a receipt or invoice to a bank line as evidence. The file is stored
 * privately with its SHA-256; the local OCR + LLM reads it (if running) and a fixed rule
 * scores how well it matches the line. It never changes the line's tag.
 */
export const POST = handle(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const me = await requireNgo();
  const { id } = await ctx.params;
  const find = () => {
    const db = getDb();
    const t = db.bankTxns.find((x) => x.id === id);
    const acc = t && db.bankAccounts.find((a) => a.id === t.accountId && a.ngoId === me.ngoId);
    if (!t || !acc || !canSeeTxn(t, me, db)) throw new HttpError(404, "Transaction not found");
    return t;
  };
  find();
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) throw new HttpError(400, "Choose a receipt file (image or PDF)");

  return withLock(`receipt:${id}`, async () => {
    const stored = { ...(await saveUpload(file, "receipt")), public: false };
    const dup = getDb().files.find((f) => f.sha256 === stored.sha256);
    if (dup) {
      const usedOn = getDb().bankTxns.find((t) => t.receipts?.some((r) => r.fileId === dup.id));
      if (usedOn) fs.rmSync(path.join(uploadsDir(), stored.id), { force: true });
      if (usedOn) throw new HttpError(409, usedOn.id === id ? "This exact file is already attached to this line" : `This exact file is already attached to another bank line (${usedOn.date}, ${fmt(Math.abs(usedOn.amount))})`);
    }
    mutate((db) => db.files.push(stored));
    const scan = await scanReceipt(stored);

    const view = mutate((db) => {
      const t = db.bankTxns.find((x) => x.id === id)!;
      const codes = new Set(t.allocations.flatMap((a) => db.funds.find((f) => f.id === a.fundId)?.trackingCodes ?? []));
      const printed = scan.extraction?.printedCode?.split("-")[0];
      const r: BankReceipt = {
        fileId: stored.id,
        engine: scan.engine,
        extraction: scan.extraction,
        match: scan.extraction ? scoreReceipt(t, scan.extraction) : { score: 0, signals: ["Not read automatically"] },
        codeMismatch: printed && t.allocations.length && !codes.has(printed) ? `Receipt shows #${scan.extraction!.printedCode}, but the line is tagged to ${t.allocations.map((a) => db.funds.find((f) => f.id === a.fundId)?.title).join(", ")}` : undefined,
        note: scan.note,
        byId: me.id,
        byName: me.name,
        at: nowIso(),
      };
      (t.receipts ??= []).push(r);
      audit(db, {
        actor: actorOf(me),
        action: "bank.receipt_added",
        fundId: t.allocations[0]?.fundId,
        targetId: t.id,
        summary: `Attached receipt "${stored.name}" to bank ${t.amount < 0 ? "payment" : "receipt"} ${fmt(Math.abs(t.amount))} "${t.description.slice(0, 80)}"${scan.extraction ? ` · match score ${r.match.score}/100` : ""}${r.codeMismatch ? ` · ${r.codeMismatch}` : ""}`,
        meta: { sha256: stored.sha256, score: r.match.score, engine: r.engine },
      });
      return txnView(db, t, me);
    });
    announce([]);
    return json({ ok: true, transaction: view, message: scan.extraction ? `Receipt attached · match score ${view.receipts.at(-1)!.match.score}/100` : `Receipt attached${scan.note ? `. ${scan.note}` : ""}` });
  });
});
