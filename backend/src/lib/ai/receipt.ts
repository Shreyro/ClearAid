import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { aiEnabled } from "../config";
import { uploadsDir } from "../db";
import type { BankReceipt, StoredFile } from "../types";
import { structured } from "./client";

/**
 * Read a receipt or invoice attached to a bank payment. The AI fills in the
 * evidence record only: it never sets or changes the payment's tracking code
 * or fund. Matching to the bank line is a fixed rule (see `scoreReceipt`).
 */

const Schema = z.object({
  supplier: z.string().nullable().describe("Supplier or merchant name as printed"),
  invoiceNumber: z.string().nullable().describe("Invoice, bill or receipt number"),
  date: z.string().nullable().describe("Receipt date as YYYY-MM-DD"),
  currency: z.string().nullable().describe("ISO currency code, e.g. USD"),
  total: z.number().nullable().describe("Grand total as printed, in the receipt's currency"),
  printedCode: z
    .string()
    .nullable()
    .describe('A tracking code printed on the receipt, written like "#RO1" or "#ASHA-MED", without the #. Null if none.'),
  lineItems: z.array(z.object({ description: z.string(), amount: z.number().nullable() })),
  legible: z.boolean(),
});

const SYSTEM = `You read receipts, bills and invoices for an NGO's finance team. Extract exactly what is printed. Never guess: use null for anything you can't read. Don't infer a tracking code; only report one that is printed on the document (a "#" followed by letters/digits).`;

function block(f: StoredFile): Anthropic.Beta.BetaContentBlockParam | null {
  const p = path.join(uploadsDir(), f.id);
  if (!fs.existsSync(p)) return null;
  const data = fs.readFileSync(p).toString("base64");
  if (f.mime === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  if (["image/jpeg", "image/png", "image/webp"].includes(f.mime)) {
    return { type: "image", source: { type: "base64", media_type: f.mime as "image/jpeg" | "image/png" | "image/webp", data } };
  }
  return null;
}

export async function scanReceipt(f: StoredFile): Promise<{ engine: BankReceipt["engine"]; extraction?: BankReceipt["extraction"]; note?: string }> {
  if (!aiEnabled()) return { engine: "none", note: "AI reading is off (set ANTHROPIC_API_KEY). The file is stored and hashed; fill in details by hand if needed." };
  const b = block(f);
  if (!b) return { engine: "none", note: "This file type can't be read automatically." };
  try {
    const x = await structured({ schema: Schema, system: SYSTEM, content: [b, { type: "text", text: "Extract this receipt." }], effort: "low", maxTokens: 3000 });
    return {
      engine: "claude",
      extraction: {
        ...x,
        printedCode: x.printedCode ? x.printedCode.replace(/^#/, "").toUpperCase() : null,
        lineItems: x.lineItems.slice(0, 40),
      },
    };
  } catch (e) {
    return { engine: "none", note: `Couldn't read the receipt automatically: ${(e as Error).message}` };
  }
}
