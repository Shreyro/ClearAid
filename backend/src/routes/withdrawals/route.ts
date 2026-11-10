import { runAudit } from "@/lib/ai/audit";
import { redactPII, ruleRedact } from "@/lib/ai/redact";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { publish } from "@/lib/events";
import { findFund } from "@/lib/funds";
import { after, handle, json } from "@/lib/http";
import { toCents } from "@/lib/money";
import { actorOf, getSession, HttpError, ngoCanSeeFund, requireFundAccess, requireNgo } from "@/lib/session";
import { audit } from "@/lib/audit";
import { CATEGORIES, type Category, type StoredFile } from "@/lib/types";
import { saveUpload } from "@/lib/uploads";
import { withdrawalView } from "@/lib/views";

export const GET = handle(async (req: Request) => {
  const s = await getSession();
  const q = new URL(req.url).searchParams;
  const db = getDb();
  const list = db.withdrawals
    .filter((w) => ngoCanSeeFund(s, findFund(db, w.fundId)!))
    .filter((w) => !q.get("fund") || w.fundId === q.get("fund"))
    .filter((w) => !q.get("status") || q.get("status")!.split(",").includes(w.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((w) => withdrawalView(db, w, s));
  return json({ withdrawals: list });
});

/** A file from a multipart form: whatever `FormData` holds that isn't a text value. */
type Upload = Exclude<ReturnType<FormData["getAll"]>[number], string>;

/** Staff on a fund log a vendor's payment request with the receipt and proof photos. */
export const POST = handle(async (req: Request) => {
  const me = await requireNgo();
  const form = await req.formData();
  const db = getDb();
  const { fund } = await requireFundAccess(String(form.get("fundId") ?? ""));
  if (fund.status !== "active") throw new Error("This fund is not accepting new withdrawal requests");
  const vendor = db.vendors.find((v) => v.id === String(form.get("vendorId") ?? "") && v.ngoId === fund.ngoId);
  if (!vendor) throw new Error("Choose the vendor being paid");
  const amount = toCents(Number(form.get("amountUsd")));
  if (!(amount > 0)) throw new Error("Enter the amount requested");
  const category = String(form.get("category")) as Category;
  if (!CATEGORIES.some((c) => c.id === category)) throw new Error("Pick a category");
  const purpose = String(form.get("purpose") ?? "").trim();
  if (purpose.length < 10) throw new Error("Describe what was delivered and where");

  // A multipart field holds text values and files; keep the non-empty files.
  const files = (field: string) => form.getAll(field).filter((f): f is Upload => typeof f !== "string" && f.size > 0);
  const receipts = files("receipts").slice(0, 3);
  const photos = files("photos").slice(0, 6);
  if (!receipts.length) throw new Error("Attach the receipt or invoice");
  let meta: { dhash?: string; exif?: StoredFile["exif"] }[] = [];
  try {
    meta = JSON.parse(String(form.get("photoMeta") ?? "[]"));
  } catch {
    meta = [];
  }
  const saved = {
    receipts: await Promise.all(receipts.map((f) => saveUpload(f, "receipt"))),
    photos: await Promise.all(photos.map((f, i) => saveUpload(f, "photo", meta[i]))),
  };
  const needId = String(form.get("needId") ?? "") || undefined;
  const num = (k: string) => (form.get(k) ? Math.max(0, Math.round(Number(form.get(k)))) || undefined : undefined);
  const quick = ruleRedact(purpose);

  const w = mutate((db2) => {
    db2.files.push(...saved.receipts, ...saved.photos);
    const rec = {
      id: newId("wd"),
      fundId: fund.id,
      vendorId: vendor.id,
      amount,
      category,
      needId: fund.needs.some((n) => n.id === needId) ? needId : undefined,
      quantity: num("quantity"),
      beneficiaries: num("beneficiaries"),
      location: String(form.get("location") ?? "").slice(0, 120) || undefined,
      purposeRaw: purpose.slice(0, 2000),
      purposePublic: quick.text,
      piiFound: quick.found,
      receiptFileIds: saved.receipts.map((f) => f.id),
      photoFileIds: saved.photos.map((f) => f.id),
      status: "auditing" as const,
      approvals: [],
      createdAt: nowIso(),
    };
    db2.withdrawals.push(rec);
    audit(db2, { actor: actorOf(me), action: "withdrawal.submitted", fundId: fund.id, targetId: rec.id, summary: `Logged a ${(amount / 100).toFixed(2)} USD payment request from ${vendor.name}`, meta: { amount, vendor: vendor.name } });
    return rec;
  });
  publish({ kind: "withdrawal", fundId: fund.id, withdrawalId: w.id, status: "auditing" });

  // Redaction + AI audit run after the response so the vendor isn't kept waiting.
  after(async () => {
    const red = await redactPII(w.purposeRaw);
    mutate((db3) => {
      const x = db3.withdrawals.find((y) => y.id === w.id);
      if (x) {
        x.purposePublic = red.text;
        x.piiFound = red.found;
      }
    });
    await runAudit(w.id);
  });
  return json({ id: w.id, status: "auditing", piiFound: quick.found });
});
