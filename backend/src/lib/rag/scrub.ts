/**
 * The model sometimes explains where a figure came from using the prompt's own
 * headings ("as listed under TOTAL MONEY OUT in the FUND SUMMARIES"). Drop those
 * sentences: the person only needs the answer.
 */
const HEADINGS =
  "FUND SUMMAR(?:Y|IES)|PASSAGES?|LARGEST (?:PAYEES|SOURCES)|TOTAL MONEY (?:IN|OUT)|MONEY OUT|LIFECYCLE|PROGRESS TO GOAL|BIGGEST SPENDING CATEGORY|BANK LINES NOT ON ANY FUND|BY MONTH|RANKED|COMPARISONS AND TOTALS|EACH FUND|(?:PAYEES|SOURCES) (?:THIS|LAST) MONTH|(?:THIS|LAST) MONTH";
const LEAK = new RegExp(`\\b(?:${HEADINGS})`);
// "(LAST MONTH (2026-10): money in $1, spent $2)" and "(MONEY OUT) section": the data's own labels in brackets.
const LEAK_PAREN = new RegExp(`\\s*\\((?:[^()]|\\([^()]*\\))*?\\b(?:${HEADINGS})(?:[^()]|\\([^()]*\\))*\\)(?:\\s+section)?`, "g");

/** The model sometimes answers, then "corrects" itself in a later sentence. Keep the first answer. */
const SECOND_GUESS = /^(however|but|actually),? (if you're asking|if you mean|it's actually|that said)/i;

const SPLIT = /(?<=[.!?])[ \t]+(?=[A-Z$])/;

export function scrub(text: string) {
  text = text.replace(LEAK_PAREN, "");
  const sentences = text.split(SPLIT);
  const cut = sentences.findIndex((s, i) => i > 0 && SECOND_GUESS.test(s));
  if (cut > 0) text = sentences.slice(0, cut).join(" ");
  // Line by line, so a list keeps its lines.
  const lines = text.split("\n").map((line) => line.split(SPLIT).filter((s) => !LEAK.test(s)).join(" "));
  const kept = lines.join("\n");
  const out = kept.trim() ? kept : text.replace(new RegExp(LEAK.source, "g"), "").replace(/[ \t]{2,}/g, " ");
  return out
    .replace(/,?\s*(?:as|which is|that is) (?:shown|mentioned|listed|stated|noted|given|found) (?:in|under) the (?:fund )?(?:summary|summaries|passages?)(?: \[\d+\])?/gi, "")
    .replace(/\b(?:according to|as per|based on) the fund summar(?:y|ies),?\s*/gi, "")
    .replace(/\b(?:the )?passages? \[(\d+)\]/gi, (_m, n) => `record [${n}]`)
    .replace(/(^|[.!?]\s+)record \[/g, "$1Record [")
    .replace(/\b(?:according to|as per|based on) the (?:the )?(?:records|summaries|summary|data|passages)\s*,?\s*/gi, "")
    .replace(/\b(?:according to|as per|based on) the\s*,\s*/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}
