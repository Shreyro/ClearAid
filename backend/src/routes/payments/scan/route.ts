import fs from "node:fs";
import path from "node:path";
import { scanReceipt } from "@/lib/ai/receipt";
import { codeIndex, matchCodes } from "@/lib/banking";
import { getDb, mutate, uploadsDir } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { fmt } from "@/lib/money";
import { paymentsOf } from "@/lib/payments";
import { HttpError, requireNgo } from "@/lib/session";
import { saveUpload } from "@/lib/uploads";

/**
 * Step 1 of declaring a payment: upload the receipt or invoice. The file is
 * stored privately with its SHA-256 and Claude reads it. Nothing is posted:
 * the reading only pre-fills the form, which the person checks and corrects.
 */
export const POST = handle(async (req: Request) => {
  const me = await requireNgo();
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) throw new HttpError(400, "Choose the receipt or invoice (image or PDF)");

  let stored;
  try {
    stored = { ...(await saveUpload(file, "receipt")), public: false };
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }

  // The same file can only be evidence for one payment.
  const db = getDb();
  const dup = db.files.find((f) => f.sha256 === stored.sha256);
  if (dup) {
    const onPayment = paymentsOf(db).find((p) => p.receipt?.fileId === dup.id && p.status !== "void");
    const onLine = db.bankTxns.find((t) => t.receipts?.some((r) => r.fileId === dup.id));
    if (onPayment || onLine) {
      fs.rmSync(path.join(uploadsDir(), stored.id), { force: true });
      throw new HttpError(
        409,
        onPayment
          ? `This exact receipt was already used for a ${fmt(onPayment.amount)} payment to ${onPayment.payee} on ${onPayment.date}`
          : `This exact receipt is already attached to a bank line (${onLine!.date}, ${fmt(Math.abs(onLine!.amount))})`,
      );
    }
  }
  mutate((d) => d.files.push(stored));

  const scan = await scanReceipt(stored);
  mutate((d) => {
    const f = d.files.find((x) => x.id === stored.id);
    if (f) f.scan = { ...scan, ngoId: me.ngoId };
  });

  // A tracking code printed on the receipt suggests the fund (and a sub-code the category). Only a suggestion.
  let suggestion: { fundId?: string; category?: string; code?: string } = {};
  const printed = scan.extraction?.printedCode;
  if (printed) {
    const m = matchCodes(`#${printed}`, codeIndex(getDb(), me.ngoId));
    if (m.kind === "tagged") suggestion = { fundId: m.fund.id, category: m.category, code: m.code };
  }

  return json({
    fileId: stored.id,
    fileName: stored.name,
    url: `/api/files/${stored.id}`,
    engine: scan.engine,
    extraction: scan.extraction ?? null,
    note: scan.note,
    suggestion,
  });
});
