import { cookies } from "next/headers";
import { getDb } from "./db";
import type { Session } from "./types";

/**
 * DEMO identity: a cookie holding "role:id". There is no password — the
 * persona switcher in the header lets judges try every side of the product.
 * Replace with real auth (e.g. Log in with PayPal for donors) in production.
 */
export const SESSION_COOKIE = "clearaid_persona";

export async function getSession(): Promise<Session> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const [role, id] = decodeURIComponent(raw).split(":");
  const db = getDb();
  if (role === "donor" && db.donors.some((d) => d.id === id)) return { role, id };
  if (role === "vendor" && db.vendors.some((v) => v.id === id)) return { role, id };
  if (role === "ngo" && db.ngos.some((n) => n.admins.some((a) => a.id === id))) return { role, id };
  return { role: "public" };
}

export function ngoAdmin(id?: string) {
  for (const n of getDb().ngos) {
    const a = n.admins.find((x) => x.id === id);
    if (a) return { ...a, ngoId: n.id, ngoName: n.name };
  }
  return null;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function requireRole(role: Session["role"]) {
  const s = await getSession();
  if (s.role !== role) throw new HttpError(403, `Switch to a ${role} persona to do this`);
  return s;
}
