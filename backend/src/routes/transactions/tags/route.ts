import { audit } from "@/lib/audit";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { metaOf, TAG_COLORS, tagsOf } from "@/lib/entry-meta";
import { publish } from "@/lib/events";
import { handle, json } from "@/lib/http";
import { actorOf, HttpError, requireNgo } from "@/lib/session";

/** The NGO's category tags for transactions, with how often each is used. Staff only. */
export const GET = handle(async () => {
  const me = await requireNgo();
  const db = getDb();
  const used = new Map<string, number>();
  for (const m of Object.values(metaOf(db))) for (const id of m.tagIds ?? []) used.set(id, (used.get(id) ?? 0) + 1);
  return json({
    tags: tagsOf(db)
      .filter((t) => t.ngoId === me.ngoId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ id: t.id, name: t.name, color: t.color, uses: used.get(t.id) ?? 0, createdByName: t.createdByName, mine: t.createdBy === me.id })),
    colors: TAG_COLORS,
  });
});

type Body = { action: "create"; name?: string; color?: string } | { action: "update"; id?: string; name?: string; color?: string } | { action: "delete"; id?: string };

const cleanName = (s?: string) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 40);

/**
 * Staff create tags; the person who made a tag, or an admin, can rename,
 * recolour or delete it (deleting takes it off every transaction).
 */
export const POST = handle(async (req: Request) => {
  const me = await requireNgo();
  const b = (await req.json()) as Body;
  const actor = actorOf(me);
  const out = mutate((db) => {
    const tags = tagsOf(db);
    const taken = (name: string, except?: string) => tags.some((t) => t.ngoId === me.ngoId && t.id !== except && t.name.toLowerCase() === name.toLowerCase());
    const color = (c?: string) => (TAG_COLORS as readonly string[]).includes(c ?? "") ? c! : TAG_COLORS[tags.filter((t) => t.ngoId === me.ngoId).length % TAG_COLORS.length];

    if (b.action === "create") {
      const name = cleanName(b.name);
      if (name.length < 2) throw new HttpError(400, "Name the tag (2 to 40 characters), e.g. \"Boat hire\"");
      if (taken(name)) throw new HttpError(409, `There's already a tag called "${name}"`);
      if (tags.filter((t) => t.ngoId === me.ngoId).length >= 200) throw new HttpError(400, "Up to 200 tags");
      const t = { id: newId("tag"), ngoId: me.ngoId, name, color: color(b.color), createdBy: me.id, createdByName: me.name, createdAt: nowIso() };
      tags.push(t);
      audit(db, { actor, action: "tag.created", targetId: t.id, summary: `Created the transaction tag "${name}"` });
      return { tag: t, message: `Tag "${name}" created.` };
    }

    const t = tags.find((x) => x.id === b.id && x.ngoId === me.ngoId);
    if (!t) throw new HttpError(404, "Tag not found");
    if (me.role !== "admin" && t.createdBy !== me.id) throw new HttpError(403, "Only the person who made this tag, or an admin, can change it");

    if (b.action === "update") {
      const name = b.name === undefined ? t.name : cleanName(b.name);
      if (name.length < 2) throw new HttpError(400, "Name the tag (2 to 40 characters)");
      if (taken(name, t.id)) throw new HttpError(409, `There's already a tag called "${name}"`);
      const nextColor = b.color === undefined ? t.color : color(b.color);
      if (name === t.name && nextColor === t.color) throw new HttpError(400, "No change");
      audit(db, { actor, action: "tag.updated", targetId: t.id, summary: name !== t.name ? `Renamed the tag "${t.name}" to "${name}"` : `Changed the colour of the tag "${t.name}"` });
      t.name = name;
      t.color = nextColor;
      return { tag: t, message: "Tag saved." };
    }

    if (b.action === "delete") {
      let removed = 0;
      for (const m of Object.values(metaOf(db))) {
        if (m.tagIds?.includes(t.id)) {
          m.tagIds = m.tagIds.filter((id) => id !== t.id);
          removed++;
        }
      }
      tags.splice(tags.indexOf(t), 1);
      audit(db, { actor, action: "tag.deleted", targetId: t.id, summary: `Deleted the tag "${t.name}"${removed ? ` (it was on ${removed} transaction${removed === 1 ? "" : "s"})` : ""}` });
      return { tag: null, message: `Tag "${t.name}" deleted${removed ? ` and taken off ${removed} transaction${removed === 1 ? "" : "s"}` : ""}.` };
    }
    throw new HttpError(400, "Unknown action");
  });
  publish({ kind: "bank" });
  return json({ ok: true, ...out });
});
