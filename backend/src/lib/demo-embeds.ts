import { mutate, newId, nowIso } from "./db";
import { ALL_FUNDS, embedsOf } from "./embed";
import type { EmbedPublish, PublicEmbed } from "./types";

/**
 * The demo NGO website (demo-site/) shows three ClearAid embeds. Their keys are
 * fixed, so the same demo pages work on a fresh local copy and on the hosted
 * demo without pasting anything. The keys are public by design (they only open
 * a read-only widget of the demo funds) and are created only when the demo NGO's
 * funds exist. Set DEMO_EMBEDS=off to switch this off.
 */
const NGO = "ngo_crc";
const ADMIN = { id: "adm_priya", name: "Priya Raman" };

const base: EmbedPublish = { totals: true, sources: true, categories: true, payees: "off", flow: false, timeline: false, activity: 0, integrity: true, funds: false };

const DEMO: { key: string; name: string; fundId: string; fundIds?: string[]; theme: "light" | "dark" | "auto"; publish: EmbedPublish }[] = [
  { key: "demo-all-funds", name: "Demo site: every fund (dark)", fundId: ALL_FUNDS, theme: "dark", publish: { ...base, funds: true, flow: true, timeline: true, integrity: true } },
  { key: "demo-cyclone-asha", name: "Demo site: Cyclone Asha (light)", fundId: "fund_asha", theme: "light", publish: { ...base, payees: "registered", activity: 10 } },
  { key: "demo-floods", name: "Demo site: Mahanadi and Monsoon (device colours)", fundId: "fund_mahanadi", fundIds: ["fund_mahanadi", "fund_monsoon"], theme: "auto", publish: { ...base, funds: true, activity: 5 } },
];

export function ensureDemoEmbeds() {
  if (process.env.DEMO_EMBEDS?.trim().toLowerCase() === "off") return;
  mutate((db) => {
    if (!db.ngos.some((n) => n.id === NGO)) return;
    const embeds = embedsOf(db);
    for (const d of DEMO) {
      if (embeds.some((e) => e.key === d.key)) continue;
      const ids = d.fundIds ?? [d.fundId];
      if (d.fundId !== ALL_FUNDS && !ids.every((id) => db.funds.some((f) => f.id === id && f.ngoId === NGO))) continue;
      const at = nowIso();
      const e: PublicEmbed = {
        id: newId("emb"),
        key: d.key,
        ngoId: NGO,
        fundId: d.fundId,
        ...(d.fundIds ? { fundIds: d.fundIds } : {}),
        theme: d.theme,
        name: d.name,
        publish: d.publish,
        enabled: true,
        createdAt: at,
        createdBy: ADMIN.id,
        createdByName: ADMIN.name,
        updatedAt: at,
        updatedByName: ADMIN.name,
      };
      embeds.push(e);
    }
  });
}
