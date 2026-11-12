/**
 * A small model sometimes states an amount that is nowhere in the records it was
 * given. Every dollar figure in an answer must appear in the data we sent (or the
 * question), so we can check that in code and drop what can't be backed up.
 */
const MONEY = /\$\s?(\d[\d,]*(?:\.\d+)?)/g;

const cents = (s: string) => Math.round(parseFloat(s.replace(/,/g, "")) * 100);

/** Every amount written in the text, in cents. */
export function amountsIn(text: string): number[] {
  return [...text.matchAll(MONEY)].map((m) => cents(m[1])).filter((n) => Number.isFinite(n));
}

/** Amounts in `reply` that don't appear in `known` (a figure also counts if it is a known one rounded to whole dollars). */
export function unsupportedAmounts(reply: string, known: string): number[] {
  const have = new Set(amountsIn(known));
  const whole = new Set([...have].map((c) => Math.round(c / 100)));
  return [...new Set(amountsIn(reply))].filter((c) => !have.has(c) && !(c % 100 === 0 && whole.has(c / 100)));
}

const SENTENCE = /(?<=[.!?])\s+(?=[A-Z$\[])/;

/** Remove every sentence that states an unsupported amount. Returns undefined if nothing is left. */
export function dropUnsupported(reply: string, known: string): string | undefined {
  const kept = reply.split(SENTENCE).filter((s) => !unsupportedAmounts(s, known).length);
  return kept.length ? kept.join(" ").trim() : undefined;
}

export const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
