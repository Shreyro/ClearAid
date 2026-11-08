import { getDb } from "@/lib/db";
import { HttpError } from "@/lib/session";

/** A fund that can take donations through its public link. */
export function givableFund(slug: string) {
  const db = getDb();
  const fund = db.funds.find((f) => f.slug === slug);
  if (!fund) throw new HttpError(404, "This donation link doesn't match a fund");
  const ngo = db.ngos.find((n) => n.id === fund.ngoId);
  const code = fund.trackingCodes?.[0];
  return { db, fund, ngo, code };
}

export const MIN_GIFT = 100;
export const MAX_GIFT = 1_000_000;
