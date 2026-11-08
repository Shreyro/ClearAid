import { audit } from "@/lib/audit";
import { CODE_RE, normaliseCode, rescanUntagged } from "@/lib/banking";
import { getDb, mutate } from "@/lib/db";
import { type Ctx, handle, json } from "@/lib/http";
import { actorOf, HttpError, requireNgoAdmin } from "@/lib/session";
import { announce } from "../../../bank/shared";

/**
 * Set a fund's tracking codes (admins). A fund can have several codes, and a
 * code can belong to only one fund. Afterwards the Untagged queue is checked
 * again, so lines carrying a newly added code are tagged straight away.
 */
export const POST = handle(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const admin = await requireNgoAdmin();
  const { id } = await ctx.params;
  const b = (await req.json()) as { codes?: string[] };
  const codes = [...new Set((b.codes ?? []).map(normaliseCode).filter(Boolean))];
  if (codes.length > 12) throw new HttpError(400, "Up to 12 codes per fund");
  for (const c of codes) if (!CODE_RE.test(c)) throw new HttpError(400, `"${c}" isn't a valid code: start with a letter, then 1–11 letters or digits (e.g. RO1, ASHA, FL24). No dashes; the part after a dash is the budget category.`);

  const res = mutate((db) => {
    const fund = db.funds.find((f) => (f.id === id || f.slug === id) && f.ngoId === admin.ngoId);
    if (!fund) throw new HttpError(404, "Fund not found");
    for (const c of codes) {
      const other = db.funds.find((f) => f.id !== fund.id && f.ngoId === admin.ngoId && (f.trackingCodes ?? []).includes(c));
      if (other) throw new HttpError(409, `#${c} is already used by ${other.title}`);
    }
    const before = fund.trackingCodes ?? [];
    const added = codes.filter((c) => !before.includes(c));
    const removed = before.filter((c) => !codes.includes(c));
    if (!added.length && !removed.length) throw new HttpError(400, "No change");
    fund.trackingCodes = codes;
    const scan = added.length ? rescanUntagged(db, admin.ngoId) : { tagged: 0, entries: [] };
    audit(db, {
      actor: actorOf(admin),
      action: "fund.codes_updated",
      fundId: fund.id,
      targetId: fund.id,
      summary: `Tracking codes for ${fund.title}: ${codes.map((c) => `#${c}`).join(", ") || "none"}${added.length ? ` (added ${added.map((c) => `#${c}`).join(", ")})` : ""}${removed.length ? ` (removed ${removed.map((c) => `#${c}`).join(", ")}; lines already tagged keep their tag)` : ""}${scan.tagged ? `. ${scan.tagged} waiting bank line(s) now matched and were tagged` : ""}`,
    });
    return { fund, scan };
  });
  announce(res.scan.entries);
  return json({ ok: true, codes: res.fund.trackingCodes, retagged: res.scan.tagged, message: res.scan.tagged ? `${res.scan.tagged} waiting transaction(s) now match a code and were tagged.` : "Codes saved." });
});
