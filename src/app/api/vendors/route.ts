import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { handle, json } from "@/lib/http";
import { ngoAdmin, requireRole } from "@/lib/session";
import { CATEGORIES, type Category } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const db = getDb();
  return json({ vendors: db.vendors.map((v) => ({ id: v.id, name: v.name, category: v.category, location: v.location, verified: v.verified, funds: db.funds.filter((f) => f.vendorIds.includes(v.id)).map((f) => f.id) })) });
});

/** NGO registers a vendor, or verifies one (which adds it to all of the NGO's funds). */
export const POST = handle(async (req: Request) => {
  const s = await requireRole("ngo");
  const admin = ngoAdmin(s.id)!;
  const b = (await req.json()) as { verifyId?: string; name?: string; paypalEmail?: string; category?: Category; location?: string };
  if (b.verifyId) {
    return json(
      mutate((db) => {
        const v = db.vendors.find((x) => x.id === b.verifyId);
        if (!v) throw new Error("Unknown vendor");
        v.verified = true;
        for (const f of db.funds) if (f.ngoId === admin.ngoId && !f.vendorIds.includes(v.id)) f.vendorIds.push(v.id);
        return { ok: true, id: v.id };
      }),
    );
  }
  if (!b.name?.trim() || !/^\S+@\S+\.\S+$/.test(b.paypalEmail ?? "")) throw new Error("Vendor name and PayPal email are required");
  const category = CATEGORIES.some((c) => c.id === b.category) ? b.category! : "food";
  return json(
    mutate((db) => {
      const v = { id: newId("vnd"), name: b.name!.trim(), paypalEmail: b.paypalEmail!.trim(), category, location: b.location?.trim() || "", verified: false, ngoId: admin.ngoId, joinedAt: nowIso() };
      db.vendors.push(v);
      return { ok: true, id: v.id };
    }),
  );
});
