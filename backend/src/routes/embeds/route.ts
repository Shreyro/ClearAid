import { audit } from "@/lib/audit";
import { getDb, mutate, newId, nowIso } from "@/lib/db";
import { ALL_FUNDS, cleanPublish, cleanTheme, embedsOf, THEME_LABEL, embedView, newEmbedKey, publishedBlocks, selectedFunds } from "@/lib/embed";
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

type Selection = { allFunds?: boolean; fundIds?: string[]; /** Older clients: one fund. */ fundId?: string; theme?: string };
type Body =
  | ({ action: "create"; name?: string; publish?: unknown } & Selection)
  | ({ action: "update"; id: string; name?: string; publish?: unknown } & Selection)
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
    const describe = (sel: { fundId: string; fundIds?: string[] }) =>
      sel.fundId === ALL_FUNDS ? "all funds (including funds added later)" : selectedFunds(db, admin.ngoId, sel).map((f) => f.title).join(", ") || "a fund";
    const titleOf = (e: PublicEmbed) => describe(e);
    // Read the ticked funds: "all", or one or more of this NGO's funds.
    const selection = (b: Selection): { fundId: string; fundIds?: string[] } => {
      if (b.allFunds) {
        if (!db.funds.some((f) => f.ngoId === admin.ngoId)) throw new HttpError(400, "Create a fund first");
        return { fundId: ALL_FUNDS };
      }
      const asked = [...new Set(b.fundIds?.length ? b.fundIds : b.fundId ? [b.fundId] : [])];
      const ok = asked.filter((id) => db.funds.some((f) => f.id === id && f.ngoId === admin.ngoId));
      if (!ok.length || ok.length !== asked.length) throw new HttpError(400, "Tick at least one of your funds to publish");
      return ok.length === 1 ? { fundId: ok[0] } : { fundId: ok[0], fundIds: ok };
    };
    const combined = (sel: { fundId: string; fundIds?: string[] }) => sel.fundId === ALL_FUNDS || (sel.fundIds?.length ?? 0) > 1;
    // "Each fund's totals" only means something when two or more funds are published together.
    const settingsFor = (sel: { fundId: string; fundIds?: string[] }, raw: unknown) => {
      const p = cleanPublish(raw);
      return combined(sel) ? p : { ...p, funds: false };
    };
    const auditFund = (sel: { fundId: string; fundIds?: string[] }) => (combined(sel) ? undefined : sel.fundId);

    if (b.action === "create") {
      const sel = selection(b);
      if (embeds.filter((e) => e.ngoId === admin.ngoId).length >= MAX_EMBEDS) throw new HttpError(400, `Up to ${MAX_EMBEDS} embeds. Delete one you no longer use.`);
      const publish = settingsFor(sel, b.publish);
      const blocks = publishedBlocks(publish);
      if (!blocks.length) throw new HttpError(400, "Choose at least one thing to publish");
      const at = nowIso();
      const what = describe(sel);
      const e: PublicEmbed = {
        id: newId("emb"),
        key: newEmbedKey(),
        ngoId: admin.ngoId,
        ...sel,
        theme: cleanTheme(b.theme),
        name: cleanName(b.name, sel.fundId === ALL_FUNDS ? "All funds embed" : combined(sel) ? "Combined funds embed" : `${what} embed`),
        publish,
        enabled: true,
        createdAt: at,
        createdBy: admin.id,
        createdByName: admin.name,
        updatedAt: at,
        updatedByName: admin.name,
      };
      embeds.push(e);
      audit(db, { actor, action: "embed.created", fundId: auditFund(sel), targetId: e.id, summary: `Published a public embed "${e.name}" for ${what}. It shows: ${blocks.join(", ")}` });
      return { embed: e, message: "Published. Copy the code below into your website." };
    }

    const e = mine(b.id);
    if (b.action === "update") {
      // The ticked funds can change too; the link (key) stays the same.
      const sel = b.allFunds || b.fundIds?.length || b.fundId ? selection(b) : { fundId: e.fundId, fundIds: e.fundIds };
      const fundsBefore = describe(e);
      const fundsAfter = describe(sel);
      const before = publishedBlocks(e.publish);
      const publish = settingsFor(sel, b.publish === undefined ? e.publish : b.publish);
      const after = publishedBlocks(publish);
      if (!after.length) throw new HttpError(400, "Choose at least one thing to publish");
      const name = cleanName(b.name, e.name);
      const themeBefore = e.theme ?? "light";
      const themeAfter = b.theme === undefined ? themeBefore : cleanTheme(b.theme);
      const added = after.filter((x) => !before.includes(x));
      const removed = before.filter((x) => !after.includes(x));
      if (name === e.name && !added.length && !removed.length && fundsBefore === fundsAfter && themeBefore === themeAfter) throw new HttpError(400, "No change");
      const renamed = name !== e.name ? ` Renamed from "${e.name}".` : "";
      const refunded = fundsBefore !== fundsAfter ? ` Funds changed from ${fundsBefore} to ${fundsAfter}.` : "";
      const rethemed = themeAfter !== themeBefore ? ` Colours changed from ${THEME_LABEL[themeBefore]} to ${THEME_LABEL[themeAfter]}.` : "";
      e.name = name;
      e.publish = publish;
      e.fundId = sel.fundId;
      e.theme = themeAfter;
      if (sel.fundIds) e.fundIds = sel.fundIds;
      else delete e.fundIds;
      e.updatedAt = nowIso();
      e.updatedByName = admin.name;
      audit(db, {
        actor,
        action: "embed.updated",
        fundId: auditFund(e),
        targetId: e.id,
        summary: `Changed public embed "${e.name}" for ${titleOf(e)}. It now shows: ${after.join(", ")}${added.length ? ` (added ${added.join(", ")})` : ""}${removed.length ? ` (removed ${removed.join(", ")})` : ""}.${renamed}${refunded}${rethemed}`,
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
        fundId: auditFund(e),
        targetId: e.id,
        summary: enabled ? `Resumed public embed "${e.name}" for ${titleOf(e)}. It shows: ${publishedBlocks(e.publish).join(", ")}` : `Paused public embed "${e.name}" for ${titleOf(e)}. Its link shows nothing until it is resumed`,
      });
      return { embed: e, message: enabled ? "Live again at the same link." : "Paused. Websites showing it now see a notice instead of your numbers." };
    }
    if (b.action === "delete") {
      embeds.splice(embeds.indexOf(e), 1);
      audit(db, { actor, action: "embed.deleted", fundId: auditFund(e), targetId: e.id, summary: `Deleted public embed "${e.name}" for ${titleOf(e)}. Its link no longer works` });
      return { embed: null, message: "Deleted. Its link no longer works." };
    }
    throw new HttpError(400, "Unknown action");
  });

  return json({ ok: true, embed: res.embed ? embedView(getDb(), res.embed) : null, message: res.message });
});
