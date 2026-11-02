import { z } from "zod/v4";
import { structured } from "./client";

export interface Redaction {
  text: string;
  found: { type: string; count: number }[];
  engine: "claude" | "rules";
}

// Deterministic first pass. Always runs, so obvious identifiers never reach
// the public ledger even if the AI call fails.
const RULES: { type: string; re: RegExp }[] = [
  { type: "EMAIL", re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { type: "GOV_ID", re: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g }, // national-ID style 12 digit numbers
  { type: "PHONE", re: /(?:\+?\d{1,3}[ -]?)?(?:\(?\d{2,5}\)?[ -]?)\d{3,5}[ -]?\d{4,5}\b/g },
  { type: "ACCOUNT", re: /\b(?:a\/c|acct|account|iban|upi)[:#\s-]*[A-Z0-9@._-]{6,}\b/gi },
  { type: "NAME", re: /\b(?:Mr|Mrs|Ms|Smt|Shri|Dr)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g },
];

export function ruleRedact(input: string): Redaction {
  let text = input;
  const counts = new Map<string, number>();
  for (const { type, re } of RULES) {
    text = text.replace(re, () => {
      counts.set(type, (counts.get(type) ?? 0) + 1);
      return `[${type}]`;
    });
  }
  return { text, found: [...counts].map(([type, count]) => ({ type, count })), engine: "rules" };
}

const Schema = z.object({
  redacted: z.string().describe("The input with every piece of personal data replaced by a [TYPE] placeholder"),
  entities: z.array(
    z.object({
      type: z.enum(["NAME", "PHONE", "EMAIL", "GOV_ID", "ADDRESS", "ACCOUNT", "MEDICAL", "AGE", "OTHER"]),
      count: z.number(),
    }),
  ),
});

const SYSTEM = `You redact personal data from disaster-relief spending notes before they are published on a public donor ledger.

Replace with a bracketed type placeholder: names of private individuals (beneficiaries, patients, children, volunteers), phone numbers, emails, government or ID numbers, bank/UPI/account identifiers, exact household addresses or house numbers, medical conditions tied to a person, and ages tied to a named or identifiable person.

Keep (do not redact): organisation and vendor business names, item names and quantities, prices, dates, and general locations such as a village, camp, district or ward. Keep the rest of the sentence unchanged so it stays readable. Placeholders that are already present, like [PHONE], stay as they are.`;

export async function redactPII(input: string): Promise<Redaction> {
  const first = ruleRedact(input);
  try {
    const out = await structured({ schema: Schema, system: SYSTEM, content: first.text, effort: "low", maxTokens: 2000 });
    const merged = new Map(first.found.map((f) => [f.type, f.count]));
    for (const e of out.entities) merged.set(e.type, Math.max(merged.get(e.type) ?? 0, e.count));
    return { text: out.redacted, found: [...merged].map(([type, count]) => ({ type, count })), engine: "claude" };
  } catch {
    return first;
  }
}
