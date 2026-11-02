import type { AuditCheck, DB, Fund, StoredFile, Withdrawal } from "./types";
import { categoryLabel } from "./types";
import { fmt } from "./money";
import { fundStats } from "./funds";

/** Hamming distance between two 64-bit hex hashes. */
export function hamming(a: string, b: string) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

function km(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/**
 * Deterministic, explainable fraud & policy rules. These run before (and
 * independently of) the AI audit, so the system stays safe even if the model
 * is unavailable, and the AI is told what the rules found.
 */
export function ruleChecks(db: DB, fund: Fund, w: Withdrawal): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const add = (id: string, label: string, status: AuditCheck["status"], detail: string) =>
    checks.push({ id, label, status, detail, source: "rules" });

  const vendor = db.vendors.find((v) => v.id === w.vendorId);
  if (!vendor) add("vendor", "Vendor verified", "fail", "Unknown vendor");
  else if (!vendor.verified) add("vendor", "Vendor verified", "fail", `${vendor.name} has not completed verification`);
  else if (!fund.vendorIds.includes(vendor.id)) add("vendor", "Vendor verified", "warn", `${vendor.name} is verified but not on this fund's approved vendor list`);
  else add("vendor", "Vendor verified", "pass", `${vendor.name} is a verified vendor for this fund`);

  const stats = fundStats(db, fund);
  if (w.amount > stats.balance) add("balance", "Funds available", "fail", `Requested ${fmt(w.amount)} but only ${fmt(stats.balance)} remains`);
  else add("balance", "Funds available", "pass", `${fmt(stats.balance)} available`);

  if (w.amount > fund.policy.maxSingleWithdrawal)
    add("limit", "Single-withdrawal limit", "fail", `Exceeds the ${fmt(fund.policy.maxSingleWithdrawal)} per-request limit`);
  else add("limit", "Single-withdrawal limit", "pass", `Within the ${fmt(fund.policy.maxSingleWithdrawal)} limit`);

  const cap = fund.policy.categoryCaps[w.category];
  if (cap !== undefined) {
    const spentCat = (stats.byCategory[w.category] ?? 0) + w.amount;
    const pct = stats.raised ? (spentCat / stats.raised) * 100 : 100;
    if (pct > cap)
      add("cap", "Category budget", "fail", `${categoryLabel(w.category)} would reach ${pct.toFixed(1)}% of funds raised (cap ${cap}%)`);
    else if (pct > cap * 0.85)
      add("cap", "Category budget", "warn", `${categoryLabel(w.category)} would reach ${pct.toFixed(1)}% of the ${cap}% cap`);
    else add("cap", "Category budget", "pass", `${categoryLabel(w.category)} at ${pct.toFixed(1)}% of a ${cap}% cap`);
  }

  if (w.needId && w.quantity) {
    const need = fund.needs.find((n) => n.id === w.needId);
    if (need) {
      const unit = w.amount / w.quantity;
      const ratio = unit / need.unitCost;
      if (ratio > 2) add("price", "Unit price sanity", "fail", `${fmt(Math.round(unit))}/${need.unit} is ${ratio.toFixed(1)}× the expected ${fmt(need.unitCost)}`);
      else if (ratio > 1.35) add("price", "Unit price sanity", "warn", `${fmt(Math.round(unit))}/${need.unit} is ${ratio.toFixed(1)}× the expected ${fmt(need.unitCost)}`);
      else add("price", "Unit price sanity", "pass", `${fmt(Math.round(unit))}/${need.unit} vs ${fmt(need.unitCost)} expected`);
    }
  }

  const files = (ids: string[]) => ids.map((id) => db.files.find((f) => f.id === id)).filter(Boolean) as StoredFile[];
  const receipts = files(w.receiptFileIds);
  const photos = files(w.photoFileIds);
  const others = db.withdrawals.filter((o) => o.id !== w.id);

  if (!receipts.length) add("receipt", "Receipt attached", "fail", "No receipt or invoice uploaded");
  else {
    const dup = others.find((o) => files(o.receiptFileIds).some((f) => receipts.some((r) => r.sha256 === f.sha256)));
    if (dup) add("receipt_dup", "Receipt is unique", "fail", `Identical receipt file was already used on request ${dup.id}`);
    else add("receipt_dup", "Receipt is unique", "pass", "Receipt not seen on any other request");
  }

  if (!photos.length) {
    add("photos", "Proof-of-delivery photos", fund.policy.requirePhotos ? "fail" : "warn", "No delivery photos uploaded");
  } else {
    add("photos", "Proof-of-delivery photos", "pass", `${photos.length} photo${photos.length > 1 ? "s" : ""} attached`);
    let reuse: { id: string; dist: number } | null = null;
    for (const p of photos) {
      if (!p.dhash) continue;
      for (const o of others) {
        for (const f of files(o.photoFileIds)) {
          if (!f.dhash) continue;
          const d = hamming(p.dhash, f.dhash);
          if (d <= 10 && (!reuse || d < reuse.dist)) reuse = { id: o.id, dist: d };
        }
      }
    }
    if (reuse)
      add(
        "photo_reuse",
        "Photos are original",
        reuse.dist <= 6 ? "fail" : "warn",
        `Photo is ${Math.round(((64 - reuse.dist) / 64) * 100)}% visually similar to one on request ${reuse.id}`,
      );
    else add("photo_reuse", "Photos are original", "pass", "No visual match with any earlier proof photo");

    const dated = photos.filter((p) => p.exif?.takenAt);
    if (!dated.length) add("photo_time", "Photo timestamps", "warn", "Photos carry no capture time metadata");
    else {
      const early = dated.filter((p) => Date.parse(p.exif!.takenAt!) < Date.parse(fund.startedAt) - 86400_000);
      if (early.length) add("photo_time", "Photo timestamps", "fail", `${early.length} photo(s) were taken before this crisis began`);
      else add("photo_time", "Photo timestamps", "pass", "All dated photos were taken after the fund opened");
    }
    const geo = photos.filter((p) => p.exif?.lat !== undefined && p.exif?.lng !== undefined);
    if (geo.length) {
      const far = Math.max(...geo.map((p) => km(fund.lat, fund.lng, p.exif!.lat!, p.exif!.lng!)));
      if (far > 400) add("photo_geo", "Photo location", "warn", `A photo was taken ${Math.round(far)} km from the affected area`);
      else add("photo_geo", "Photo location", "pass", `Taken within ${Math.round(far)} km of the affected area`);
    }
  }

  return checks;
}

export function rulesRisk(checks: AuditCheck[]) {
  return Math.min(100, checks.reduce((a, c) => a + (c.status === "fail" ? 30 : c.status === "warn" ? 8 : 0), 0));
}
