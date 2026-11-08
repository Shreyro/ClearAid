import { createHash } from "node:crypto";
import { audit } from "@/lib/audit";
import { ingestRows } from "@/lib/banking";
import { detectMapping, missingFields, parseCsv, rowsFromCsv } from "@/lib/csv";
import { getDb, mutate } from "@/lib/db";
import { type Ctx, handle, json } from "@/lib/http";
import { fmt } from "@/lib/money";
import { actorOf, HttpError, requireNgo } from "@/lib/session";
import type { CsvMapping } from "@/lib/types";
import { accountView, announce, findAccount } from "../../../shared";

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Upload a CSV statement. `preview: true` returns the detected column mapping
 * and the first rows without saving anything; the second call (with the
 * confirmed `mapping`) imports. Any NGO staff member can upload.
 */
export const POST = handle(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const me = await requireNgo();
  const { id } = await ctx.params;
  const b = (await req.json()) as { fileName?: string; content?: string; mapping?: CsvMapping; preview?: boolean };
  const account = findAccount(getDb(), me.ngoId, id);
  if (account.status !== "active") throw new HttpError(400, "This account is disconnected");
  const content = String(b.content ?? "");
  if (!content.trim()) throw new HttpError(400, "The file is empty");
  if (Buffer.byteLength(content) > MAX_BYTES) throw new HttpError(413, "Statements up to 5 MB, please. Split larger files by month.");
  const grid = parseCsv(content);
  if (grid.length < 2) throw new HttpError(400, "Expected a header row and at least one transaction");
  const header = grid[0];
  const detected = detectMapping(header, grid.slice(1, 30));
  const mapping: CsvMapping = { ...(account.csvMapping && account.csvMapping.date && header.includes(account.csvMapping.date) ? account.csvMapping : detected), ...b.mapping } as CsvMapping;
  const missing = missingFields(mapping);
  for (const k of ["date", "description", "amount", "debit", "credit", "reference", "counterparty", "type"] as const) {
    const v = mapping[k];
    if (v && !header.includes(v)) throw new HttpError(400, `Column "${v}" isn't in this file`);
  }

  if (b.preview || missing.length) {
    const parsed = missing.length ? { rows: [], errors: [] } : rowsFromCsv(grid, mapping);
    return json({
      preview: true,
      header,
      mapping,
      missing,
      sample: grid.slice(1, 6),
      parsed: parsed.rows.slice(0, 8),
      rowCount: grid.length - 1,
      validCount: parsed.rows.length,
      errors: parsed.errors.slice(0, 20),
      totals: { in: parsed.rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0), out: -parsed.rows.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0) },
    });
  }

  const sha = createHash("sha256").update(content).digest("hex");
  const { rows, errors } = rowsFromCsv(grid, mapping);
  if (!rows.length) throw new HttpError(400, `No rows could be read. ${errors.slice(0, 3).join("; ")}`);
  const res = mutate((db) => {
    const acc = findAccount(db, me.ngoId, id);
    const dup = db.statementImports.find((i) => i.accountId === acc.id && i.fileSha256 === sha);
    if (dup) throw new HttpError(409, `This exact file was already imported on ${dup.createdAt.slice(0, 10)}`);
    acc.csvMapping = mapping;
    const r = ingestRows(db, acc, rows, { source: "csv", fileName: b.fileName?.slice(0, 120) || "statement.csv", fileSha256: sha, actor: actorOf(me), errors });
    const untagged = r.imp.imported - r.imp.autoTagged;
    audit(db, {
      actor: actorOf(me),
      action: "bank.imported",
      targetId: r.imp.id,
      summary: `Imported ${r.imp.fileName} into ${acc.name}: ${r.imp.imported} new (${r.imp.autoTagged} tagged by code, ${untagged} need a tag), ${r.imp.duplicates} already imported${errors.length ? `, ${errors.length} unreadable` : ""}`,
      meta: { rows: r.imp.rows, imported: r.imp.imported, autoTagged: r.imp.autoTagged, duplicates: r.imp.duplicates, sha256: sha.slice(0, 16) },
    });
    return r;
  });
  announce(res.entries);
  const db = getDb();
  return json({ ok: true, import: res.imp, account: accountView(db, findAccount(db, me.ngoId, id)), message: `${res.imp.imported} new transactions (${res.imp.autoTagged} tagged by code), ${res.imp.duplicates} skipped as already imported. Money posted to funds: ${fmt(res.entries.reduce((s, e) => s + Math.abs(e.amount), 0))}.` });
});
