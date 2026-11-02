import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { donorLabel } from "@/lib/funds";
import { handle, json } from "@/lib/http";
import { getSession, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const db = getDb();
  const session = await getSession();
  const personaIds = ["dnr_maya", "dnr_arjun", "dnr_sofia", "dnr_brightline"];
  if (session.role === "donor" && session.id && !personaIds.includes(session.id)) personaIds.unshift(session.id);
  const label = () => {
    if (session.role === "donor") return db.donors.find((d) => d.id === session.id)?.name;
    if (session.role === "vendor") return db.vendors.find((v) => v.id === session.id)?.name;
    if (session.role === "ngo") return db.ngos.flatMap((n) => n.admins).find((a) => a.id === session.id)?.name;
    return "Public visitor";
  };
  return json({
    session: { ...session, name: label() },
    personas: {
      donors: personaIds.map((id) => db.donors.find((d) => d.id === id)).filter(Boolean).map((d) => ({ id: d!.id, name: d!.name, sub: donorLabel(d) })),
      ngo: db.ngos.flatMap((n) => n.admins.map((a) => ({ id: a.id, name: a.name, sub: `${a.title}, ${n.name}` }))),
      vendors: db.vendors.map((v) => ({ id: v.id, name: v.name, sub: v.verified ? v.location : "Pending verification" })),
    },
  });
});

export const POST = handle(async (req: Request) => {
  const { role, id } = (await req.json()) as { role: string; id?: string };
  const res = NextResponse.json({ ok: true });
  if (role === "public") res.cookies.delete(SESSION_COOKIE);
  else res.cookies.set(SESSION_COOKIE, `${role}:${id}`, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  return res;
});
