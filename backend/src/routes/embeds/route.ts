import { audit } from "@/lib/audit";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { cleanPublish, embedsOf, embedView, newEmbedKey, publishedBlocks } from "@/lib/embed";
import { handle, json } from "@/lib/http";
import { actorOf, HttpError, requireNgoAdmin } from "@/lib/session";
import type { PublicEmbed } from "@/lib/types";

const MAX_EMBEDS = 50;

/** The NGO's public embeds and the funds one can be made for (admins). */
export const GET = handle(async () => {
  const admin = await requireNgoAdmin();
  const db = getDb();
  return json({
    embeds: embedsOf(db)
      .filter((e) => e.ngoId === admin.ngoId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((e) => embedView(db, e)),
    funds: db.funds.filter((f) => f.ngoId === admin.ngoId).map((f) => ({ id: f.id, title: f.title, status: f.status })),
  });
});

type Body =
  | { action: "create"; fundId: string; name?: string; publish?: unknown }
  | { action: "update"; id: string; name?: string; publish?: unknown }
  | { action: "pause" | "resume" | "delete"; id: string };

const cleanName = (raw: unknown, fallback: string) => (typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 60) : fallback);

/**
 * Create, change, pause, resume or delete an embed (admins). Each change is
 * written to the audit log with the list of what the embed publishes.
 */
export const POST = handle(async (req: Request) => {
  const admin = await requireNgoAdmin();
  const b = (await req.json()) as Body;
  const actor = actorOf(admin);

  const res = mutate((db) => {
    const embeds = embedsOf(db);
    const mine = (id: string) => {
      const e = embeds.find((x) => x.id === id && x.ngoId === admin.ngoId);
      if (!e) throw new HttpError(404, "Embed not found");
      return e;
    };
    const titleOf = (e: PublicEmbed) => db.funds.find((f) => f.id === e.fundId)?.title ?? "a fund";

    if (b.action === "create") {
      const fund = db.funds.find((f) => f.id === b.fundId && f.ngoId === admin.ngoId);
      if (!fund) throw new HttpError(400, "Choose the fund to publish");
      if (embeds.filter((e) => e.ngoId === admin.ngoId).length >= MAX_EMBEDS) throw new HttpError(400, `Up to ${MAX_EMBEDS} embeds. Delete one you no longer use.`);
      const publish = cleanPublish(b.publish);
      const blocks = publishedBlocks(publish);
      if (!blocks.length) throw new HttpError(400, "Choose at least one thing to publish");
      const at = nowIso();
      const e: PublicEmbed = {
        id: newId("emb"),
        key: newEmbedKey(),
        ngoId: admin.ngoId,
        fundId: fund.id,
        name: cleanName(b.name, `${fund.title} embed`),
        publish,
        enabled: true,
        createdAt: at,
        createdBy: admin.id,
        createdByName: admin.name,
        updatedAt: at,
        updatedByName: admin.name,
      };
      embeds.push(e);
      audit(db, { actor, action: "embed.created", fundId: fund.id, targetId: e.id, summary: `Published a public embed "${e.name}" for ${fund.title}. It shows: ${blocks.join(", ")}` });
      return { embed: e, message: "Published. Copy the code below into your website." };
    }

    const e = mine(b.id);
    if (b.action === "update") {
      const before = publishedBlocks(e.publish);
      const publish = b.publish === undefined ? e.publish : cleanPublish(b.publish);
      const after = publishedBlocks(publish);
      if (!after.length) throw new HttpError(400, "Choose at least one thing to publish");
      const name = cleanName(b.name, e.name);
      const added = after.filter((x) => !before.includes(x));
      const removed = before.filter((x) => !after.includes(x));
      if (name === e.name && !added.length && !removed.length) throw new HttpError(400, "No change");
      const renamed = name !== e.name ? ` Renamed from "${e.name}".` : "";
      e.name = name;
      e.publish = publish;
      e.updatedAt = nowIso();
      e.updatedByName = admin.name;
      audit(db, {
        actor,
        action: "embed.updated",
        fundId: e.fundId,
        targetId: e.id,
        summary: `Changed public embed "${e.name}" for ${titleOf(e)}. It now shows: ${after.join(", ")}${added.length ? ` (added ${added.join(", ")})` : ""}${removed.length ? ` (removed ${removed.join(", ")})` : ""}.${renamed}`,
      });
      return { embed: e, message: "Saved. The embed on your website updates by itself." };
    }
    if (b.action === "pause" || b.action === "resume") {
      const enabled = b.action === "resume";
      if (e.enabled === enabled) throw new HttpError(400, enabled ? "This embed is already live" : "This embed is already paused");
      e.enabled = enabled;
      e.updatedAt = nowIso();
      e.updatedByName = admin.name;
      audit(db, {
        actor,
        action: enabled ? "embed.resumed" : "embed.paused",
        fundId: e.fundId,
        targetId: e.id,
        summary: enabled ? `Resumed public embed "${e.name}" for ${titleOf(e)}. It shows: ${publishedBlocks(e.publish).join(", ")}` : `Paused public embed "${e.name}" for ${titleOf(e)}. Its link shows nothing until it is resumed`,
      });
      return { embed: e, message: enabled ? "Live again at the same link." : "Paused. Websites showing it now see a notice instead of your numbers." };
    }
    if (b.action === "delete") {
      embeds.splice(embeds.indexOf(e), 1);
      audit(db, { actor, action: "embed.deleted", fundId: e.fundId, targetId: e.id, summary: `Deleted public embed "${e.name}" for ${titleOf(e)}. Its link no longer works` });
      return { embed: null, message: "Deleted. Its link no longer works." };
    }
    throw new HttpError(400, "Unknown action");
  });

  return json({ ok: true, embed: res.embed ? embedView(getDb(), res.embed) : null, message: res.message });
});
