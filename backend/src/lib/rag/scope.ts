import { canViewFund, isDonor, ngoCanSeeFund, ngoMember } from "../session";
import type { DB, Fund, Session } from "../types";
import { type Audience, fundIndex, untracedIndex } from "./docs";

/**
 * Who may ask about what. This is the only place the Copilot's access is
 * decided, and it uses the same rules as the screens:
 *   admin  every fund of their NGO, full detail, plus untraced bank lines
 *   staff  the funds they're assigned to, full detail, plus untraced bank lines
 *   donor  the funds an admin assigned to them, redacted (public) detail only
 * The search service is only ever handed the indexes listed here, so a fund
 * outside this list can't reach the model at all.
 */
export type Scope = {
  audience: Audience;
  funds: Fund[];
  indexes: string[];
  includeUntraced: boolean;
};

export function scopeFor(db: DB, session: Session): Scope {
  const m = session.role === "ngo" ? ngoMember(session.id) : null;
  if (!m) return { audience: "public", funds: [], indexes: [], includeUntraced: false };
  const donor = isDonor(session);
  const audience: Audience = donor ? "public" : "staff";
  const funds = db.funds.filter((f) => f.ngoId === m.ngoId && (donor ? canViewFund(session, f) : ngoCanSeeFund(session, f)));
  const includeUntraced = !donor;
  return {
    audience,
    funds,
    indexes: [...funds.map((f) => fundIndex(f.id, audience)), ...(includeUntraced ? [untracedIndex(m.ngoId)] : [])],
    includeUntraced,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();

/** Words a person might use for a fund: its title (and the distinctive part of it), slug and tracking codes. */
function names(f: Fund) {
  const title = norm(f.title);
  const lead = norm(f.title.split(/[—–:-]/)[0]);
  const out = new Set([title, lead, norm(f.slug.replace(/-/g, " ")), ...(f.trackingCodes ?? []).flatMap((c) => [norm(c), `#${norm(c)}`])]);
  // "Cyclone Asha" → also "asha"; skip generic words.
  for (const w of lead.split(" ")) if (w.length >= 4 && !GENERIC.has(w)) out.add(w);
  return [...out].filter((n) => n.length >= 3);
}
const GENERIC = new Set(["fund", "relief", "cyclone", "flood", "floods", "recovery", "appeal", "emergency", "coastal", "response", "preparedness"]);

/**
 * Funds the question names. Matched against every fund of the NGO, so a
 * question about a fund the person can't see is recognised and refused
 * instead of being answered from their other funds.
 */
export function fundsMentioned(question: string, all: Fund[]) {
  const q = ` ${norm(question)} `;
  return all.filter((f) => names(f).some((n) => q.includes(` ${n} `)));
}
