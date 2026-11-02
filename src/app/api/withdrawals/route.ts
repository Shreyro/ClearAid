import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { after } from "next/server";
import { runAudit } from "@/lib/ai/audit";
import { redactPII, ruleRedact } from "@/lib/ai/redact";
import { getDb, mutate, newId, nowIso, uploadsDir } from "@/lib/db";
import { publish } from "@/lib/events";
import { findFund } from "@/lib/funds";
import { handle, json } from "@/lib/http";
import { toCents } from "@/lib/money";
import { getSession, HttpError, requireRole } from "@/lib/session";
import { CATEGORIES, type Category, type StoredFile } from "@/lib/types";
import { withdrawalView } from "@/lib/views";

export const dynamic = "force-dynamic";

const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 8 * 1024 * 1024;

export const GET = handle(async (req: Request) => {
  const s = await getSession();
  const q = new URL(req.url).searchParams;
  const db = getDb();
  if (s.role !== "ngo" && s.role !== "vendor") throw new HttpError(403, "NGO or vendor persona required");
  const list = db.withdrawals
    .filter((w) => (s.role === "vendor" ? w.vendorId === s.id : true))
    .filter((w) => !q.get("fund") || w.fundId === q.get("fund"))
    .filter((w) => !q.get("status") || q.get("status")!.split(",").includes(w.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((w) => withdrawalView(db, w, s));
  return json({ withdrawals: list });
});

async function saveUpload(file: File, kind: StoredFile["kind"], meta?: { dhash?: string; exif?: StoredFile["exif"] }): Promise<StoredFile> {
  const allowed = kind === "receipt" ? RECEIPT_TYPES : PHOTO_TYPES;
  if (!allowed.includes(file.type)) throw new Error(`${file.name}: unsupported file type ${file.type || "unknown"}`);
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 8 MB`);
  const buf = Buffer.from(await file.arrayBuffer());
  const id = newId("file");
  fs.mkdirSync(uploadsDir(), { recursive: true });
  fs.writeFileSync(path.join(uploadsDir(), id), buf);
  const exif = meta?.exif && {
    takenAt: meta.exif.takenAt && !Number.isNaN(Date.parse(meta.exif.takenAt)) ? new Date(meta.exif.takenAt).toISOString() : undefined,
    lat: Number.isFinite(meta.exif.lat) ? Number(meta.exif.lat) : undefined,
    lng: Number.isFinite(meta.exif.lng) ? Number(meta.exif.lng) : undefined,
    device: meta.exif.device?.slice(0, 60),
    software: meta.exif.software?.slice(0, 60),
  };
  return {
    id,
    kind,
    mime: file.type,
    name: file.name.slice(0, 120),
    size: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    dhash: meta?.dhash && /^[0-9a-f]{16}$/.test(meta.dhash) ? meta.dhash : undefined,
    exif,
    public: true,
    createdAt: nowIso(),
  };
}

/** Vendor submits a withdrawal request with receipts and proof photos. */
export const POST = handle(async (req: Request) => {
  const s = await requireRole("vendor");
  const form = await req.formData();
  const db = getDb();
  const fund = findFund(db, String(form.get("fundId") ?? ""));
  if (!fund) throw new Error("Choose a fund");
  if (fund.status !== "active") throw new Error("This fund is not accepting new withdrawal requests");
  const vendor = db.vendors.find((v) => v.id === s.id)!;
  const amount = toCents(Number(form.get("amountUsd")));
  if (!(amount > 0)) throw new Error("Enter the amount requested");
  const category = String(form.get("category")) as Category;
  if (!CATEGORIES.some((c) => c.id === category)) throw new Error("Pick a category");
  const purpose = String(form.get("purpose") ?? "").trim();
  if (purpose.length < 10) throw new Error("Describe what was delivered and where");

  const receipts = form.getAll("receipts").filter((f): f is File => f instanceof File && f.size > 0).slice(0, 3);
  const photos = form.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0).slice(0, 6);
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
