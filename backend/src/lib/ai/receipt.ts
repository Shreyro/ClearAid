import { z } from "zod/v4";
import { aiEnabled, renderMode } from "../config";
import type { BankReceipt, StoredFile } from "../types";
import { imageOf, localModel, structured } from "./local";
import { isoDate, printedCode, printedTotal, readText } from "./ocr";

/**
 * Read a receipt or invoice. The AI fills in the evidence record only: it never
 * sets or changes a payment's tracking code or fund. Matching to the bank line
 * is a fixed rule (see `scoreReceipt`).
 *
 * OCR + LLM, as in FairShare: the rag/ service reads the text (EasyOCR, or a
 * PDF's own text layer), the local LLM (the same model as the Copilot) turns it
 * into fields, and fixed rules then check what can be checked from the text
 * (the tracking code, the date's format, the printed total). Without OCR, an
 * image falls back to the local vision model.
 */

const Schema = z.object({
  supplier: z.string().nullable().describe("Supplier or merchant name as printed"),
  invoiceNumber: z.string().nullable().describe("Invoice, bill or receipt number"),
  date: z.string().nullable().describe("Receipt date as YYYY-MM-DD"),
  currency: z.string().nullable().describe("ISO currency code, e.g. USD or INR"),
  total: z.number().nullable().describe("Grand total as printed, in the receipt's currency"),
  printedCode: z
    .string()
    .nullable()
    .describe('A tracking code printed on the receipt, written like "#RO1" or "#ASHA-MED", without the #. Null if none.'),
  lineItems: z.array(z.object({ description: z.string(), amount: z.number().nullable() })),
  legible: z.boolean(),
});

const SYSTEM = `You read receipts, bills and invoices for an NGO's finance team. Extract exactly what is printed. Never guess: use null for anything you can't read. Don't infer a tracking code; only report one that is printed on the document (a "#" followed by letters/digits).`;

const TEXT_SYSTEM = `${SYSTEM}

You are given the text of the document as read by OCR, one printed line per line, top to bottom. OCR can drop or misread a character; don't invent anything to make up for it. Line items are the goods or services charged, with the line's amount; leave out subtotal, tax summary and total lines. "legible" is false only if the text is too broken to read the main fields.`;

type Result = { engine: BankReceipt["engine"]; extraction?: BankReceipt["extraction"]; note?: string };

/** Fixed-rule checks on what the model read, using the OCR text where there is one. */
function tidy(x: z.infer<typeof Schema>, text?: string): NonNullable<BankReceipt["extraction"]> {
  const code = text ? printedCode(text) : x.printedCode?.replace(/^#/, "").toUpperCase() || null;
  const total = x.total ?? (text ? printedTotal(text) : null);
  return {
    ...x,
    supplier: x.supplier?.trim() || null,
    invoiceNumber: x.invoiceNumber?.trim() || null,
    date: isoDate(x.date),
    currency: x.currency?.trim().toUpperCase().slice(0, 3) || null,
    total,
    // Only a code that is really in the text counts; the model can't add one.
    printedCode: code,
    lineItems: x.lineItems.filter((l) => l.description.trim()).slice(0, 40),
  };
}

export async function scanReceipt(f: StoredFile): Promise<Result> {
  if (!aiEnabled()) return { engine: "none", note: renderMode ? "The file is stored and hashed; fill in the details by hand." : "AI reading is off (LOCAL_AI=off). The file is stored and hashed; fill in details by hand." };

  // 1. OCR the text, then the local LLM reads it.
  const ocr = await readText(f);
  if (ocr) {
    try {
      const { data } = await structured({ schema: Schema, system: TEXT_SYSTEM, prompt: `Document text (${ocr.engine === "pdf-text" ? "from the PDF" : "OCR"}):\n---\n${ocr.text}\n---\nExtract this receipt.`, maxTokens: 1500 });
      return { engine: "local", extraction: tidy(data, ocr.text), note: `Read on this machine: ${ocr.engine === "pdf-text" ? "PDF text" : "OCR"} + ${localModel()}` };
    } catch (e) {
      return { engine: "none", note: `The text was read but the local model couldn't make sense of it (${(e as Error).message}). Fill in the details by hand.` };
    }
  }

  // 2. No OCR available: an image can still go to the local vision model.
  const image = imageOf(f);
  if (!image) return { engine: "none", note: f.mime === "application/pdf" ? "This PDF couldn't be read here (start the rag service for OCR). The file is stored and hashed; fill in the details by hand." : "This file type can't be read automatically." };
  try {
    const { data, model } = await structured({ schema: Schema, system: SYSTEM, prompt: "Extract this receipt.", images: [image], maxTokens: 1500 });
    return { engine: "local", extraction: tidy(data), note: `Read on this machine by ${model} (OCR wasn't available)` };
  } catch (e) {
    return { engine: "none", note: `Couldn't read the receipt automatically: ${(e as Error).message}` };
  }
}
