/**
 * The model sometimes explains where a figure came from using the prompt's own
 * headings ("as listed under TOTAL MONEY OUT in the FUND SUMMARIES"). Drop those
 * sentences: the person only needs the answer.
 */
const LEAK =
  /\b(FUND SUMMAR(?:Y|IES)|PASSAGES?|LARGEST (?:PAYEES|SOURCES)|TOTAL MONEY (?:IN|OUT)|LIFECYCLE|PROGRESS TO GOAL|BIGGEST SPENDING CATEGORY|BANK LINES NOT ON ANY FUND|BY MONTH|RANKED|COMPARISONS AND TOTALS)\b/;

/** The model sometimes answers, then "corrects" itself in a later sentence. Keep the first answer. */
const SECOND_GUESS = /^(however|but|actually),? (if you're asking|if you mean|it's actually|that said)/i;

export function scrub(text: string) {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z$])/);
  const cut = sentences.findIndex((s, i) => i > 0 && SECOND_GUESS.test(s));
  if (cut > 0) text = sentences.slice(0, cut).join(" ");
  const kept = text.split(/(?<=[.!?])\s+(?=[A-Z$])/).filter((s) => !LEAK.test(s));
  return (kept.length ? kept : [text.replace(new RegExp(LEAK, "g"), "the records")]).join(" ").trim();
}
