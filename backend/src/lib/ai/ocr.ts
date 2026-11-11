import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { uploadsDir } from "../db";
import type { StoredFile } from "../types";

/**
 * Text of a receipt or invoice, read on this machine by the rag/ service
 * (EasyOCR for images and scanned pages, the text layer for digital PDFs; see
 * rag/ocr.py). The local LLM then turns that text into fields, the same
 * OCR + LLM approach as FairShare: reading text off a photo is the OCR's job,
 * understanding it is the LLM's.
 *
 * Returns null when the service or OCR isn't available, so callers can fall
 * back (vision model, or the person types it in).
 */
export async function readText(f: StoredFile): Promise<{ text: string; engine: string } | null> {
  if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(f.mime)) return null;
  const p = path.join(uploadsDir(), f.id);
  if (!fs.existsSync(p)) return null;
  try {
    const res = await fetch(`${config.local.ragUrl}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(config.local.ragToken ? { "X-Rag-Token": config.local.ragToken } : {}) },
      body: JSON.stringify({ data: fs.readFileSync(p).toString("base64"), mime: f.mime }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { text?: string; engine?: string };
    const text = (j.text ?? "").trim();
    return text ? { text: text.slice(0, 12_000), engine: j.engine ?? "ocr" } : null;
  } catch {
    return null;
  }
}

// --------------------------------------------- fixed-rule clean-up of fields ----

/** A tracking code printed on the document ("#RO1", "#ASHA-MED"): read from the text by rule, never guessed. */
export function printedCode(text: string): string | null {
  const m = text.match(/#\s?([A-Za-z][A-Za-z0-9]{1,11})(?:-[A-Za-z]{2,8})?\b/);
  return m ? m[1].toUpperCase() : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A date as YYYY-MM-DD, from the forms receipts use (2026-11-02, 02/11/2026, 2 Nov 2026). Day-first for d/m/y. */
export function isoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let y: number, m: number, d: number;
  let r = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (r) [y, m, d] = [+r[1], +r[2], +r[3]];
  else if ((r = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) [d, m, y] = [+r[1], +r[2], +r[3] < 100 ? 2000 + +r[3] : +r[3]];
  else if ((r = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/))) [d, m, y] = [+r[1], MONTHS.indexOf(r[2].toLowerCase()) + 1, +r[3]];
  else if ((r = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/))) [m, d, y] = [MONTHS.indexOf(r[1].toLowerCase()) + 1, +r[2], +r[3]];
  else return null;
  // A receipt dated more than 15 years ago, or after next year, is a misread.
  const thisYear = new Date().getUTCFullYear();
  if (y < thisYear - 15 || y > thisYear + 1) return null;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === iso ? iso : null;
}

/** The printed grand total, by rule: the last amount on the last line saying "total" (not "subtotal"). */
export function printedTotal(text: string): number | null {
  const lines = text.split(/\r?\n/).filter((l) => /\btotal\b/i.test(l) && !/sub\s*-?\s*total/i.test(l));
  for (const line of lines.reverse()) {
    const nums = line.replace(/,(?=\d{3}\b)/g, "").match(/\d+(?:\.\d{1,2})?/g);
    if (nums?.length) return Number(nums[nums.length - 1]);
  }
  return null;
}
