import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { newId, nowIso, uploadsDir } from "./db";
import type { StoredFile } from "./types";

const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 8 * 1024 * 1024;

/** Store an uploaded receipt or photo under DATA_DIR/uploads, with its SHA-256. */
export async function saveUpload(file: File, kind: StoredFile["kind"], meta?: { dhash?: string; exif?: StoredFile["exif"] }): Promise<StoredFile> {
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
