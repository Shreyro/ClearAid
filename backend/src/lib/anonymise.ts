import { createHmac } from "node:crypto";
import { sessionSecret } from "./session";

/**
 * Anonymise bank statement lines on the way in.
 *
 * Every line from a CSV upload or a bank feed passes through here before it is
 * stored, so personal details never reach the database, a fund ledger (whose
 * hash-chained memos can't be edited afterwards), the audit log or the Copilot.
 *
 *  - Identifiers are redacted: emails, phone numbers, account / card numbers,
 *    UPI handles and government IDs become placeholders such as `[EMAIL]` or
 *    `[ACCOUNT ••4821]` (the last four digits stay so lines can be told apart).
 *  - Names of private individuals are substituted with a stable alias such as
 *    `Person-3F9A2C`. The same person always gets the same alias within an
 *    NGO, so their money can still be followed without knowing who they are.
 *    The alias is a keyed hash, so it can't be reversed by hashing a guess.
 *  - Organisations (suppliers, foundations, clubs, registered payees) keep
 *    their names, as do tracking codes (`#RO1`, `#ASHA-MED`), amounts, dates,
 *    invoice numbers and the bank's own reference.
 *
 * Fixed rules only, no AI: the result is the same every time, and the raw text
 * is never sent anywhere. A name is recognised in the payee / payer column, or
 * in the description after a payment rail ("NEFT CR Kavya Menon …"), a role
 * word ("beneficiary …") or a title ("Dr. …"). A name written elsewhere in free
 * text is not recognised.
 */

export type PiiKind = "NAME" | "EMAIL" | "PHONE" | "ACCOUNT" | "GOV_ID";

export interface AnonymiseOptions {
  /** Aliases are stable inside this scope (the NGO) and unrelated outside it. */
  scope: string;
  /** Organisations the NGO already deals with (its registered payees); their names are never replaced. */
  knownOrganisations?: string[];
  /** The counterparty came from the bank as a merchant (a business), so it is kept as it is. */
  counterpartyIsMerchant?: boolean;
  /** Key for the aliases. Defaults to the server secret. */
  secret?: string;
}

export interface AnonymisedLine {
  description: string;
  counterparty?: string;
  /** What was replaced, if anything. */
  found: PiiKind[];
}

// ------------------------------------------------------- Tracking codes ----

/** "#RO1", "#ASHA-MED": anything shaped like a tracking code is set aside and put back untouched. */
const CODE_LIKE = /#[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g;
const HOLD_OPEN = "";
const HOLD_CLOSE = "";
const HELD = /(\d+)/g;

function setAsideCodes(text: string) {
  const kept: string[] = [];
  const masked = text.replace(CODE_LIKE, (m) => `${HOLD_OPEN}${kept.push(m) - 1}${HOLD_CLOSE}`);
  return { masked, restore: (s: string) => s.replace(HELD, (_, i: string) => kept[Number(i)]) };
}

// ---------------------------------------------------------- Identifiers ----

const NOT_IN_WORD = "(?<![A-Za-z0-9])";
const END_OF_WORD = "(?![A-Za-z0-9])";
const last4 = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").slice(-4);

const ID_RULES: { kind: PiiKind; re: RegExp; to: (match: string, ...groups: string[]) => string }[] = [
  { kind: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, to: () => "[EMAIL]" },
  // UPI / VPA handles: name@bank
  { kind: "ACCOUNT", re: /(?<![A-Za-z0-9._-])[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}(?![A-Za-z0-9])/g, to: () => "[ACCOUNT]" },
  // IBAN
  { kind: "ACCOUNT", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, to: (m) => `[ACCOUNT ••${last4(m)}]` },
  // Card number in groups of four
  { kind: "ACCOUNT", re: new RegExp(`${NOT_IN_WORD}(?:\\d{4}[ -]){3}\\d{1,7}${END_OF_WORD}`, "g"), to: (m) => `[ACCOUNT ••${last4(m)}]` },
  // 12-digit national ID in groups of four, US SSN, Indian PAN
  { kind: "GOV_ID", re: new RegExp(`${NOT_IN_WORD}\\d{4}[ -]\\d{4}[ -]\\d{4}${END_OF_WORD}`, "g"), to: () => "[GOV_ID]" },
  { kind: "GOV_ID", re: /(?<![A-Za-z0-9-])\d{3}-\d{2}-\d{4}(?![A-Za-z0-9-])/g, to: () => "[GOV_ID]" },
  { kind: "GOV_ID", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, to: () => "[GOV_ID]" },
  // Phone numbers: +91 98765 43210, (555) 123-4567, 555-123-4567
  { kind: "PHONE", re: new RegExp(`${NOT_IN_WORD}\\+\\d{1,3}[ -]?\\d{2,5}[ -]?\\d{3,5}[ -]?\\d{3,5}${END_OF_WORD}`, "g"), to: () => "[PHONE]" },
  { kind: "PHONE", re: /(?<![A-Za-z0-9(])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![A-Za-z0-9])/g, to: () => "[PHONE]" },
  // "A/C 004512889", "account no: 12345678"
  { kind: "ACCOUNT", re: /\b((?:a\/c|acct?|account)\s*(?:no\.?|number|num)?\s*[:#.-]?\s*)(\d{5,18})\b/gi, to: (_m, lead, digits) => `${lead}[ACCOUNT ••${digits.slice(-4)}]` },
  // Any other long number standing on its own (account, mobile or reference number)
  { kind: "ACCOUNT", re: new RegExp(`${NOT_IN_WORD}\\d{9,18}${END_OF_WORD}`, "g"), to: (m) => `[ACCOUNT ••${m.slice(-4)}]` },
];

function redactIdentifiers(text: string, found: Set<PiiKind>) {
  let out = text;
  for (const rule of ID_RULES) {
    out = out.replace(rule.re, (match: string, ...rest: unknown[]) => {
      found.add(rule.kind);
      // `rest` is the capture groups followed by the offset and the whole input.
      return rule.to(match, ...(rest.slice(0, -2) as string[]));
    });
  }
  return out;
}

// ----------------------------------------------------------------- Names ----

/** Words that mark a name as an organisation. Names that are also common surnames (Mills, Church, Banks) are left out on purpose. */
const ORG_WORDS = new Set(
  `ltd limited llc llp inc incorporated corp corporation co company pvt plc gmbh pte pty sons bros brothers
   foundation trust society association assoc assn club forum circle collective committee council federation union
   mission ministry ministries temple mosque parish diocese school college university institute academy hospital clinic
   pharma pharmacy pharmaceuticals medical medicals medicos labs laboratory laboratories bank finance financial insurance
   traders trading enterprises enterprise industries industry agro logistics transport transports travels courier couriers
   motors stores mart supermarket station fuel petroleum petrol energy electricity telecom systems solutions software
   technologies technology tech services supplies suppliers distributors distributor agency agencies group holdings
   partners associates hotel hotels restaurant caterers catering printers media builders construction constructions
   hardware electricals textiles foods dairy rotary lions ngo govt government municipal municipality department dept
   office authority board charity charitable giving community global international national district panchayat branch
   airlines airways railway railways shipping exports imports consulting consultants consultancy engineers engineering
   depot warehouse wholesale retail kitchen bakery opticals jewellers garage studio studios network networks
   cooperative coop sangh samiti sabha mandal sangathan seva kendra nigam`.split(/\s+/),
);

/** Ordinary statement words. They are never part of a name, and a name stops where one begins. */
const STOP_WORDS = new Set(
  `donation donations donor gift grant grants appeal collection contribution payment payments pmt transfer trf refund
   reversal salary payroll wages rent fee fees charge charges chg service commission interest tax gst tds vat invoice
   inv bill ref reference purchase order deposit withdrawal cash cheque chq check card atm pos online mobile net banking
   self own account acct anonymous unknown misc sundry various general emergency relief flood cyclone monsoon disaster
   aid cr dr credit debit inward outward remittance neft rtgs imps upi ach wire swift monthly annual quarterly weekly
   food rice grain ration rations water shelter tarpaulin tarpaulins tent tents blanket blankets medicine medicines
   hygiene kit kits truck trucks hire boat boats camp restock admin staff team field stipend travel ticket tickets
   diesel repair repairs maintenance equipment materials stationery printing advance expenses reimbursement
   paypal ppd ccd ctx web id inst xfer xfr batch settlement payout payouts
   for the and of to from by via in on at with`.split(/\s+/),
);

const CONNECTORS = new Set(["&", "and", "of"]);

const TITLE_WORD = /^(?:Mc|Mac|De|Di|Du|La|Le|Van|Von|O['’]|D['’])?[A-Z][a-z]+(?:['’-][A-Z]?[a-z]+)*$/; // Kavya, O'Brien, Anne-Marie, McDonald
const INITIAL = /^[A-Z]\.?$/; // "R." or "S"
const UPPER_WORD = /^[A-Z]{2,}(?:['’-][A-Z]+)*$/; // KAVYA
const ALIAS = /^Person-[0-9A-F]{6}$/;

type Token = { core: string; start: number; end: number; breakAfter: boolean };

/** Words with their positions. "/", "|" and "*" separate fields in many bank formats, so they split words and end a name. */
function tokenize(s: string): Token[] {
  const out: Token[] = [];
  for (const m of s.matchAll(/[^\s/|*]+/g)) {
    const raw = m[0];
    const lead = raw.match(/^[("'“‘]+/)?.[0].length ?? 0;
    let core = raw.slice(lead);
    const trail = core.match(/[)"'”’,;:!?.-]+$/)?.[0] ?? "";
    core = core.slice(0, core.length - trail.length);
    // An initial keeps its full stop: "R." is one piece of a name.
    const initial = /^[A-Z]$/.test(core) && trail.startsWith(".");
    if (initial) core += ".";
    // Punctuation ends a name, except the full stop of an initial or a short abbreviation ("St. Mary's").
    const stops = initial || (core.length <= 3 && trail.startsWith(".")) ? trail.slice(1) : trail;
    const start = m.index + lead;
    const next = s[m.index + raw.length];
    out.push({ core, start, end: start + core.length, breakAfter: /[,;:.!?)]/.test(stops) || next === "/" || next === "|" || next === "*" });
  }
  return out;
}

const norm = (word: string) => word.toLowerCase().replace(/[^a-z0-9]/g, "");
const isHeld = (core: string) => core.includes(HOLD_OPEN);
const isPlaceholder = (core: string) => core.startsWith("[") || core.endsWith("]");
/** The words of a name, lower-cased, without redaction placeholders. */
const wordList = (name: string) => tokenize(name).filter((t) => !isPlaceholder(t.core)).map((t) => norm(t.core)).filter(Boolean);
const wordsOf = (name: string) => new Set(wordList(name));

function aliasFor(name: string, opts: AnonymiseOptions) {
  const key = wordList(name).join(" ");
  const tag = createHmac("sha256", opts.secret ?? sessionSecret()).update(`clearaid-statement-alias|${opts.scope}|${key}`).digest("hex").slice(0, 6).toUpperCase();
  return `Person-${tag}`;
}

type NameContext = { knownOrgs: Set<string>[]; lineOrgWords?: Set<string> };

const isOrgWord = (w: string) => ORG_WORDS.has(w);
const withinOne = (words: string[], sets: Set<string>[]) => words.length > 0 && sets.some((s) => words.every((w) => s.has(w)));

/** Is the party in the payee / payer column a private person, an organisation, or not a name at all? */
function classifyParty(name: string, ctx: NameContext): "person" | "org" | "generic" {
  const toks = tokenize(name).filter((t) => t.core && !isPlaceholder(t.core));
  if (toks.some((t) => ALIAS.test(t.core))) return "generic";
  const words = toks.map((t) => norm(t.core)).filter(Boolean);
  if (words.some(isOrgWord) || withinOne(words, ctx.knownOrgs)) return "org";
  const nameWords = toks.filter((t) => (TITLE_WORD.test(t.core) || UPPER_WORD.test(t.core)) && !STOP_WORDS.has(norm(t.core)));
  return nameWords.length ? "person" : "generic";
}

/**
 * The run of name words starting at token `i`: capitalised words and initials
 * ("Kavya Menon", "R. Das"), or a run written in capitals ("KAVYA MENON"). It
 * ends at an ordinary word, a number, a tracking code or a field separator.
 */
function nameRun(toks: Token[], i: number) {
  const first = toks.slice(i, i + 5).find((t) => !INITIAL.test(t.core))?.core ?? "";
  const upper = UPPER_WORD.test(first);
  const fits = (c: string) => !ALIAS.test(c) && !STOP_WORDS.has(norm(c)) && (INITIAL.test(c) || (upper ? UPPER_WORD.test(c) : TITLE_WORD.test(c)));
  let j = i;
  while (j < toks.length && j - i < 5 && fits(toks[j].core)) {
    j++;
    if (toks[j - 1].breakAfter) break;
  }
  if (j === i) return null;
  const run = toks.slice(i, j);
  const whole = run.filter((t) => !INITIAL.test(t.core));
  // Initials alone aren't a name, and one word in capitals is more often an abbreviation (CSR, GST) than a person.
  if (!whole.length || (upper && run.length < 2)) return null;
  return { from: i, to: j };
}

/** A run of name words is an organisation if it says so itself, continues into one ("Friends of Puri Trust"), or is one the NGO already knows. */
function runIsOrg(toks: Token[], run: { from: number; to: number }, ctx: NameContext) {
  const words = toks.slice(run.from, run.to).map((t) => norm(t.core)).filter(Boolean);
  if (words.some(isOrgWord)) return true;
  if (withinOne(words, ctx.knownOrgs) || (ctx.lineOrgWords && words.every((w) => ctx.lineOrgWords!.has(w)))) return true;
  const next = toks[run.to];
  if (next && !toks[run.to - 1].breakAfter && CONNECTORS.has(next.core.toLowerCase())) {
    return toks.slice(run.to + 1, run.to + 4).some((t) => isOrgWord(norm(t.core)));
  }
  return false;
}

const RAILS = "NEFT|RTGS|IMPS|UPI|ACH|WIRE|SWIFT|BACS|FPS|CHAPS|SEPA|ZELLE|TRF|TRANSFER";
/** What comes just before a name: a payment rail (with CR/DR and from/to), "paid to", a role word, or a title. */
const BEFORE_A_NAME = new RegExp(
  `${NOT_IN_WORD}(?:` +
    `(?:${RAILS})(?:[\\s/:*-]+(?:CR|DR|CREDIT|DEBIT))?(?:[\\s/:*-]+(?:PAYMENT|TRANSFER|PMT))?(?:[\\s/:*-]+(?:FROM|TO|BY))?` +
    `|(?:PAYMENT|RECEIVED|PAID|DEPOSIT|CREDIT|DEBIT)\\s+(?:FROM|TO|BY)` +
    `|PAYEE|PAYER|BENEFICIARY|REMITTER|FAVOU?RING|B\\/O` +
    `|(?:MR|MRS|MS|MISS|DR|SHRI|SMT|SRI|PROF)\\.?` +
    `)${END_OF_WORD}`,
  "gi",
);

type Swap = { start: number; end: number; with: string };

function applySwaps(text: string, swaps: Swap[]) {
  let out = text;
  for (const s of [...swaps].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.with + out.slice(s.end);
  return out;
}

/** Replace the counterparty's own name wherever it appears in the description ("Sanjay & family" for "Sanjay Patnaik"). */
function replacePartyWords(text: string, partyWords: Set<string>, alias: string) {
  const toks = tokenize(text);
  const swaps: Swap[] = [];
  const isPart = (t: Token) => !isHeld(t.core) && !isPlaceholder(t.core) && partyWords.has(norm(t.core));
  for (let i = 0; i < toks.length; i++) {
    if (!isPart(toks[i])) continue;
    let j = i;
    while (j < toks.length && isPart(toks[j])) j++;
    // Needs at least one whole word: a stray initial that happens to match isn't the person.
    if (toks.slice(i, j).some((t) => norm(t.core).length >= 3)) swaps.push({ start: toks[i].start, end: toks[j - 1].end, with: alias });
    i = j - 1;
  }
  return applySwaps(text, swaps);
}

/** Replace personal names that follow a rail, a role word or a title. */
function replaceNamesInText(text: string, ctx: NameContext, opts: AnonymiseOptions, found: Set<PiiKind>) {
  const toks = tokenize(text);
  const swaps: Swap[] = [];
  let doneUpTo = 0;
  for (const m of text.matchAll(BEFORE_A_NAME)) {
    const after = m.index + m[0].length;
    let i = toks.findIndex((t) => t.start >= after);
    if (i < 0) break;
    // A tracking code, a redacted number or a bank reference can sit between the rail and the name.
    for (let skipped = 0; skipped < 4 && i < toks.length; skipped++, i++) {
      const c = toks[i].core;
      if (!(isHeld(c) || isPlaceholder(c) || ALIAS.test(c) || /\d/.test(c))) break;
    }
    const run = i < toks.length ? nameRun(toks, i) : null;
    if (!run || toks[run.from].start < doneUpTo || runIsOrg(toks, run, ctx)) continue;
    const start = toks[run.from].start;
    const end = toks[run.to - 1].end;
    swaps.push({ start, end, with: aliasFor(text.slice(start, end), opts) });
    doneUpTo = end;
    found.add("NAME");
  }
  return applySwaps(text, swaps);
}

// ------------------------------------------------------------------ Entry ----

export function anonymiseBankLine(line: { description: string; counterparty?: string }, opts: AnonymiseOptions): AnonymisedLine {
  const found = new Set<PiiKind>();
  const ctx: NameContext = { knownOrgs: (opts.knownOrganisations ?? []).map(wordsOf).filter((s) => s.size > 0) };

  let counterparty = line.counterparty?.trim() || undefined;
  let party: { words: Set<string>; alias: string } | undefined;
  if (counterparty) {
    counterparty = redactIdentifiers(counterparty, found);
    const kind = opts.counterpartyIsMerchant ? "org" : classifyParty(counterparty, ctx);
    if (kind === "org") ctx.lineOrgWords = wordsOf(counterparty);
    if (kind === "person") {
      party = { words: wordsOf(counterparty), alias: aliasFor(counterparty, opts) };
      counterparty = party.alias;
      found.add("NAME");
    }
  }

  const { masked, restore } = setAsideCodes(line.description);
  let text = redactIdentifiers(masked, found);
  if (party) text = replacePartyWords(text, party.words, party.alias);
  text = replaceNamesInText(text, ctx, opts, found);
  return { description: restore(text), counterparty, found: [...found] };
}
