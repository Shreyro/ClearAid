import type { ParsedRow } from "./banking";
import type { CsvMapping } from "./types";

/**
 * Bank statement CSV import: an RFC 4180 parser, header auto-detection for the
 * column layouts banks commonly export, and tolerant date / amount parsing.
 */

/** Split CSV text into rows of cells (quoted fields, doubled quotes, CRLF, BOM). */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const delim = guessDelimiter(s);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

function guessDelimiter(s: string) {
  const first = s.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t", "|"].map((d) => [d, first.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

const CANDIDATES: Record<Exclude<keyof CsvMapping, "dateFormat">, string[]> = {
  date: ["date", "transaction date", "txn date", "posted date", "posting date", "value date", "booking date", "tran date"],
  description: ["description", "narration", "details", "transaction details", "particulars", "memo", "remarks", "transaction description", "name"],
  amount: ["amount", "transaction amount", "amount (usd)", "value", "net amount"],
  debit: ["debit", "withdrawal", "withdrawals", "paid out", "money out", "debit amount", "withdrawal amt", "dr"],
  credit: ["credit", "deposit", "deposits", "paid in", "money in", "credit amount", "deposit amt", "cr"],
  reference: ["reference", "ref", "ref no", "reference number", "transaction id", "txn id", "cheque no", "chq/ref no", "id", "utr"],
  counterparty: ["payee", "payer", "counterparty", "beneficiary", "merchant", "party", "from/to"],
  type: ["type", "transaction type", "trntype", "code", "type code"],
};

/** Best-guess mapping from the header row. Returns null fields it can't place. */
export function detectMapping(header: string[], sample: string[][]): Partial<CsvMapping> & { dateFormat: CsvMapping["dateFormat"] } {
  const lower = header.map((h) => h.toLowerCase().replace(/\s+/g, " ").trim());
  const used = new Set<number>();
  const pick = (names: string[]) => {
    for (const n of names) {
      const i = lower.findIndex((h, j) => !used.has(j) && h === n);
      if (i >= 0) {
        used.add(i);
        return header[i];
      }
    }
    for (const n of names) {
      const i = lower.findIndex((h, j) => !used.has(j) && n.length > 3 && h.includes(n));
      if (i >= 0) {
        used.add(i);
        return header[i];
      }
    }
    return undefined;
  };
  const m: Partial<CsvMapping> = {};
  m.date = pick(CANDIDATES.date);
  m.debit = pick(CANDIDATES.debit);
  m.credit = pick(CANDIDATES.credit);
  if (!m.debit || !m.credit) {
    m.debit = m.credit = undefined;
    m.amount = pick(CANDIDATES.amount);
  }
  m.description = pick(CANDIDATES.description);
  m.reference = pick(CANDIDATES.reference);
  m.counterparty = pick(CANDIDATES.counterparty);
  m.type = pick(CANDIDATES.type);
  const di = m.date ? header.indexOf(m.date) : -1;
  return { ...m, dateFormat: guessDateFormat(sample.map((r) => r[di] ?? "")) };
}

function guessDateFormat(values: string[]): CsvMapping["dateFormat"] {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
    if (!m) continue;
    if (Number(m[1]) > 12) dmy++;
    if (Number(m[2]) > 12) mdy++;
  }
  if (mdy > dmy) return "mdy";
  if (dmy > 0) return "dmy";
  return values.some((v) => /^\d{4}-\d{2}-\d{2}/.test(v)) ? "ymd" : "dmy";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** To "YYYY-MM-DD", or null if it can't be read. */
export function parseDate(raw: string, format: CsvMapping["dateFormat"]): string | null {
  const v = raw.trim();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ok = (y: number, mo: number, d: number) => {
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
  };
  let m = v.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) return format === "mdy" ? ok(+m[3], +m[1], +m[2]) : ok(+m[3], +m[2], +m[1]);
  // "07 Nov 2026", "7-Nov-26", "Nov 7, 2026"
  m = v.match(/^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{2,4})/);
  if (m && MONTHS.includes(m[2].toLowerCase())) return ok(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  m = v.match(/^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS.includes(m[1].toLowerCase())) return ok(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  return null;
}

/** "$1,234.50", "(45.00)", "45.00 DR", "-1.234,50"? (comma decimals not supported) → cents. */
export function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let v = raw.trim();
  if (!v) return null;
  let neg = false;
  if (/^\(.*\)$/.test(v)) {
    neg = true;
    v = v.slice(1, -1);
  }
  if (/\b(DR|D)$/i.test(v)) {
    neg = true;
    v = v.replace(/\s*(DR|D)$/i, "");
  } else v = v.replace(/\s*(CR|C)$/i, "");
  v = v.replace(/[^\d.\-+]/g, "");
  if (v.startsWith("-")) {
    neg = !neg;
    v = v.slice(1);
  }
  v = v.replace(/^\+/, "");
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const cents = Math.round(Number(v) * 100);
  return neg ? -cents : cents;
}

export function missingFields(m: Partial<CsvMapping>) {
  const miss: string[] = [];
  if (!m.date) miss.push("date");
  if (!m.description) miss.push("description");
  if (!m.amount && !(m.debit && m.credit)) miss.push("amount (or debit + credit)");
  return miss;
}

/** Apply a mapping to every data row. Bad rows are reported, not imported. */
export function rowsFromCsv(grid: string[][], m: CsvMapping) {
  const [header, ...data] = grid;
  const col = (name?: string) => (name ? header.indexOf(name) : -1);
  const ci = {
    date: col(m.date),
    description: col(m.description),
    amount: col(m.amount),
    debit: col(m.debit),
    credit: col(m.credit),
    reference: col(m.reference),
    counterparty: col(m.counterparty),
    type: col(m.type),
  };
  const rows: ParsedRow[] = [];
  const errors: string[] = [];
  data.forEach((r, i) => {
    const line = i + 2;
    const date = parseDate(r[ci.date] ?? "", m.dateFormat);
    if (!date) return void errors.push(`Line ${line}: can't read the date "${r[ci.date] ?? ""}"`);
    let amount: number | null;
    if (ci.amount >= 0) amount = parseAmount(r[ci.amount]);
    else {
      const out = parseAmount(r[ci.debit]);
      const inn = parseAmount(r[ci.credit]);
      amount = inn ? Math.abs(inn) : out ? -Math.abs(out) : null;
    }
    if (!amount) return void errors.push(`Line ${line}: no amount`);
    const description = (r[ci.description] ?? "").trim();
    if (!description) return void errors.push(`Line ${line}: no description`);
    if (Date.parse(date) > Date.now() + 86400_000) return void errors.push(`Line ${line}: date ${date} is in the future`);
    rows.push({
      date,
      amount,
      description,
      reference: ci.reference >= 0 && r[ci.reference] ? r[ci.reference].slice(0, 80) : undefined,
      counterparty: ci.counterparty >= 0 && r[ci.counterparty] ? r[ci.counterparty] : undefined,
      typeCode: ci.type >= 0 && r[ci.type] ? r[ci.type] : undefined,
    });
  });
  return { rows, errors };
}
