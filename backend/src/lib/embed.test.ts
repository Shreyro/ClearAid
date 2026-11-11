import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { EmbedPublish, PublicEmbed } from "./types";

// The demo data writes sample receipts to DATA_DIR and aliases are keyed with the
// server secret, so both are pinned before any app module is loaded.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clearaid-embed-test-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-secret";
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { buildSeed } = await import("./seed");
const { ALL_FUNDS, payloadFor, buildEmbedPayload, cleanPublish, DEFAULT_PUBLISH, embedsOf, publicEmbedPayload, publishedBlocks } = await import("./embed");
const { fundStats } = await import("./funds");
const { postAllocations } = await import("./banking");

const OFF: EmbedPublish = { totals: false, sources: false, categories: false, payees: "off", flow: false, timeline: false, activity: 0, integrity: false, funds: false, donate: false };
const EVERYTHING: EmbedPublish = { totals: true, sources: true, categories: true, payees: "all", flow: true, timeline: true, activity: 25, integrity: true, funds: true, donate: true };
const allOf = (p: EmbedPublish) => payloadFor(db, asha.ngoId, { fundId: ALL_FUNDS }, p)!;
const sum = (rows: { amount: number }[] | undefined) => (rows ?? []).reduce((a, r) => a + r.amount, 0);

const db = buildSeed(7);
const asha = db.funds.find((f) => f.id === "fund_asha")!;

test("an embed with nothing switched on carries only the header", () => {
  const p = buildEmbedPayload(db, asha, OFF);
  assert.deepEqual(Object.keys(p).sort(), ["asOf", "fund", "ngo"]);
  assert.deepEqual(p.fund, { title: asha.title, region: asha.region, status: asha.status, accent: asha.accent });
  assert.deepEqual(p.ngo, { name: "Coastal Relief Collective" });
});

test("each switch adds its own block and no other", () => {
  const cases: [Partial<EmbedPublish>, string][] = [
    [{ totals: true }, "totals"],
    [{ sources: true }, "sources"],
    [{ categories: true }, "categories"],
    [{ payees: "registered" }, "payees"],
    [{ payees: "all" }, "payees"],
    [{ flow: true }, "flow"],
    [{ timeline: true }, "timeline"],
    [{ activity: 5 }, "activity"],
    [{ integrity: true }, "integrity"],
  ];
  for (const [on, block] of cases) {
    const p = buildEmbedPayload(db, asha, { ...OFF, ...on });
    assert.deepEqual(Object.keys(p).sort(), ["asOf", "fund", "ngo", block].sort(), JSON.stringify(on));
  }
});

test("the published numbers add up and match the fund's own page", () => {
  for (const fund of db.funds) {
    const s = fundStats(db, fund);
    const p = buildEmbedPayload(db, fund, { ...EVERYTHING, payees: "registered" });
    assert.deepEqual(p.totals, { in: s.raised, out: s.spent, returned: s.refunded + s.carriedOut, held: s.balance }, fund.title);
    assert.equal(sum(p.sources), s.raised, `${fund.title}: money in by channel`);
    assert.equal(sum(p.categories), s.spent, `${fund.title}: spending by category`);
    // Payees are everyone who was paid; bank fees have no payee.
    const fees = p.categories!.find((c) => c.id === "fees")?.amount ?? 0;
    assert.equal(sum(p.payees), s.spent - fees, `${fund.title}: spending by payee`);
    // Every dollar that flows into the fund flows out of it or is still held.
    const into = p.flow!.links.filter((l) => l.target === "fund").reduce((a, l) => a + l.value, 0);
    const outOf = p.flow!.links.filter((l) => l.source === "fund").reduce((a, l) => a + l.value, 0);
    assert.equal(into, outOf, `${fund.title}: flow`);
    const last = p.timeline!.at(-1)!;
    assert.deepEqual({ in: last.in, out: last.out }, { in: s.raised - s.refunded - s.carriedOut, out: s.spent }, `${fund.title}: timeline`);
    assert.deepEqual(p.integrity, { valid: true, entries: db.ledger.filter((l) => l.fundId === fund.id).length, head: s.chainHead }, fund.title);
  }
});

test("nothing internal is published, whatever is switched on", () => {
  // Everything the NGO holds that the public has no business seeing.
  const secrets = new Set<string>();
  const add = (...values: (string | undefined)[]) => values.forEach((v) => v && v.length >= 4 && secrets.add(v));
  for (const n of db.ngos) {
    add(n.id, n.paypalEmail, n.registration);
    for (const m of n.members) add(m.id, m.name, m.username, m.passwordHash, m.title);
  }
  for (const d of db.donors) add(d.id, d.name, d.email, d.publicName);
  for (const v of db.vendors) add(v.id, v.paypalEmail);
  for (const a of db.bankAccounts) add(a.id, a.name, a.institution, a.mask);
  for (const t of db.bankTxns) add(t.id, t.externalId, t.dedupeKey, t.reason, t.taggedByName, t.untaggedReason, t.importId);
  for (const w of db.withdrawals) {
    add(w.id, w.purposeRaw, w.purposePublic, w.payout?.batchId, ...w.approvals.map((a) => a.name), ...w.receiptFileIds, ...w.photoFileIds);
  }
  for (const f of db.funds) add(f.id, f.slug, ...f.trackingCodes.map((c) => `#${c}`));
  for (const e of db.auditLog) add(e.summary, e.hash);
  for (const c of db.captures) add(c.id, c.orderId);
  for (const d of db.donations) add(d.id);
  const heads = new Set(db.funds.map((f) => fundStats(db, f).chainHead));
  for (const l of db.ledger) {
    add(l.memo, l.ref, l.paypalRef, l.prevHash === "0".repeat(64) ? undefined : l.prevHash);
    if (!heads.has(l.hash)) add(l.hash);
    // A donor's public label is on the ledger, but an embed never names who gave.
    if (l.type === "donation" || l.type === "refund" || l.type.startsWith("carry_forward")) add(l.actor);
  }
  assert.ok(secrets.size > 300, "the demo data should give plenty to look for");

  // The donate form carries the fund's donation link (its slug), which is public by design; checked on its own below.
  const PUBLISHED = { ...EVERYTHING, donate: false };
  for (const fund of db.funds) {
    const text = JSON.stringify(buildEmbedPayload(db, fund, PUBLISHED));
    for (const s of secrets) assert.ok(!text.includes(s), `"${s}" was published for ${fund.title}`);
    // Times are cut to the day.
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*\d{4}-\d{2}-\d{2}T/.test(text), "only asOf may carry a time");
  }
  // The all-funds embed is held to the same rules.
  const all = JSON.stringify(allOf(PUBLISHED));
  for (const x of secrets) assert.ok(!all.includes(x), `"${x}" was published in the all-funds embed`);
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*\d{4}-\d{2}-\d{2}T/.test(all), "only asOf may carry a time");
});

test("the donate form lists only open funds, with what their public donation link already shows", () => {
  const p = allOf({ ...OFF, donate: true });
  const open = db.funds.filter((f) => f.ngoId === asha.ngoId && f.status === "active");
  assert.deepEqual(p.donate!.funds.map((f) => f.slug).sort(), open.map((f) => f.slug).sort());
  for (const f of p.donate!.funds) assert.deepEqual(Object.keys(f).sort(), ["accent", "code", "returns", "slug", "title"]);
  assert.equal(buildEmbedPayload(db, asha, OFF).donate, undefined, "off unless switched on");
});

test("with registered payees only, a bank line's own wording is never shown", () => {
  const p = buildEmbedPayload(db, asha, { ...OFF, payees: "registered", activity: 25 });
  const allowed = new Set([...db.vendors.map((v) => v.name), "Other payees"]);
  for (const row of p.payees!) assert.ok(allowed.has(row.name), `${row.name} isn't a registered payee`);
  for (const row of p.activity!) if (row.payee) assert.ok(allowed.has(row.payee), `${row.payee} isn't a registered payee`);
  // "NEFT DR Medline Pharma clinic restock" is the registered payee MedLine Pharma Distributors.
  assert.ok(p.payees!.some((r) => r.name === "MedLine Pharma Distributors"));
  // "Shelter Co tarpaulins" and the fuel station aren't registered, so they are grouped.
  const other = p.payees!.find((r) => r.other);
  assert.ok(other && other.amount >= 200_000 + 48_000);
  const text = JSON.stringify(p);
  for (const s of ["Shelter Co", "Fuel station", "Paradip", "tarpaulins INV-443"]) assert.ok(!text.includes(s), `${s} was published`);
});

test("naming every payee still hides a person's name left on an older bank line", () => {
  const copy = structuredClone(db);
  const fund = copy.funds.find((f) => f.id === "fund_asha")!;
  const account = copy.bankAccounts[0];
  // As stored before statements were anonymised on import.
  const t = {
    ...structuredClone(copy.bankTxns[0]),
    id: "btx_old",
    dedupeKey: "old",
    amount: -30_000,
    description: "NEFT DR boat hire",
    counterparty: "Ramesh Kumar a/c 004512889301",
    isFee: false,
    allocations: [{ fundId: fund.id, amount: 30_000, category: "logistics" as const }],
  };
  copy.bankTxns.push(t);
  postAllocations(copy, account, t, t.allocations, "", new Date().toISOString()); // the newest entry on the ledger

  const p = buildEmbedPayload(copy, fund, { ...OFF, payees: "all", activity: 5 });
  const text = JSON.stringify(p);
  for (const s of ["Ramesh", "Kumar", "004512889301"]) assert.ok(!text.includes(s), `${s} was published`);
  assert.ok(p.payees!.some((r) => /^Person-[0-9A-F]{6}$/.test(r.name)));
  assert.match(p.activity![0].payee ?? "", /^Person-[0-9A-F]{6}$/);
  // Organisations keep their names in this mode.
  assert.ok(p.payees!.some((r) => r.name.startsWith("Shelter Co")));
});

test("the latest movements are capped, newest first, and described in fixed words", () => {
  const p = buildEmbedPayload(db, asha, { ...OFF, activity: 10 });
  assert.equal(p.activity!.length, 10);
  const labels = new Set(["PayPal donation", "Receipt recorded by staff", "Bank transfer received", "Bank payment", "Bank fee", "Vendor payout", "Refund to a donor", "Carried in from another fund", "Carried to another fund", "Correction: a bank line was moved to another fund"]);
  for (const [i, row] of p.activity!.entries()) {
    assert.ok(labels.has(row.label), row.label);
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(row.amount > 0);
    assert.equal(row.payee, undefined, "payees are off");
    if (i) assert.ok(row.date <= p.activity![i - 1].date);
  }
});

test("settings from a request are read strictly", () => {
  assert.deepEqual(cleanPublish(undefined), OFF);
  assert.deepEqual(cleanPublish("totals"), OFF);
  assert.deepEqual(cleanPublish({ totals: "yes", sources: 1, payees: "everyone", activity: 7, integrity: null }), OFF);
  assert.deepEqual(cleanPublish({ ...EVERYTHING, ledger: true, donors: true }), EVERYTHING);
  assert.deepEqual(cleanPublish({ activity: "10", payees: "registered" }), { ...OFF, activity: 10, payees: "registered" });
  assert.deepEqual(publishedBlocks(OFF), []);
  assert.equal(publishedBlocks(DEFAULT_PUBLISH).length, 4);
  assert.equal(DEFAULT_PUBLISH.payees, "off");
});

test("only a live embed answers to its key", () => {
  const copy = structuredClone(db);
  const embed: PublicEmbed = { id: "emb_1", key: "k".repeat(22), ngoId: asha.ngoId, fundId: asha.id, name: "Website", publish: { ...OFF, totals: true }, enabled: true, createdAt: "", createdBy: "", createdByName: "", updatedAt: "", updatedByName: "" };
  delete copy.embeds; // data saved before embeds existed
  assert.equal(publicEmbedPayload(copy, embed.key), null);
  embedsOf(copy).push(embed);

  const live = publicEmbedPayload(copy, embed.key);
  assert.deepEqual(Object.keys(live!.payload).sort(), ["asOf", "fund", "ngo", "theme", "totals"]);
  assert.equal(live!.payload.theme, "light", "older embeds are light");
  assert.equal(publicEmbedPayload(copy, "nope"), null);
  assert.equal(publicEmbedPayload(copy, embed.id), null, "the internal id is not a key");

  embed.enabled = false;
  assert.equal(publicEmbedPayload(copy, embed.key), null, "paused");
  embed.enabled = true;
  embed.ngoId = "ngo_other";
  assert.equal(publicEmbedPayload(copy, embed.key), null, "a fund of another NGO");
});

test("an all-funds embed adds every fund together and can list each fund", () => {
  const funds = db.funds.filter((f) => f.ngoId === asha.ngoId);
  const p = allOf(EVERYTHING);
  assert.equal(p.scope, "combined");
  const total = (k: "raised" | "spent" | "balance") => funds.reduce((a, f) => a + fundStats(db, f)[k], 0);
  assert.equal(p.totals!.in, total("raised"));
  assert.equal(p.totals!.out, total("spent"));
  assert.equal(p.totals!.held, total("balance"));
  assert.deepEqual(p.funds!.map((f) => f.title).sort(), funds.map((f) => f.title).sort());
  assert.equal(sum(p.funds!.map((f) => ({ amount: f.in }))), p.totals!.in);
  // Spending by category across funds equals what went out (bank fees included).
  assert.equal(sum(p.categories), p.totals!.out);
  // One box per fund in the diagram, none named by internal id.
  const fundNodes = p.flow!.nodes.filter((n) => n.kind === "fund");
  assert.ok(fundNodes.length >= 2 && fundNodes.every((n) => /^fund:\d+$/.test(n.id)));
  assert.ok(p.activity!.every((m) => m.fund && funds.some((f) => f.title === m.fund)));
  assert.equal(p.integrity!.ledgers, funds.length);
  // A single-fund embed never carries the per-fund list, even if asked.
  assert.equal(buildEmbedPayload(db, asha, EVERYTHING).funds, undefined);
});

test("an all-funds embed answers to its key and follows new funds", () => {
  const copy = structuredClone(db);
  const embed: PublicEmbed = { id: "emb_all", key: "a".repeat(22), ngoId: asha.ngoId, fundId: ALL_FUNDS, name: "Home", publish: { ...OFF, totals: true, funds: true }, enabled: true, createdAt: "", createdBy: "", createdByName: "", updatedAt: "", updatedByName: "" };
  embedsOf(copy).push(embed);
  const before = publicEmbedPayload(copy, embed.key)!.payload.funds!.length;
  copy.funds.push({ ...structuredClone(copy.funds[0]), id: "fund_new", slug: "new", title: "Brand new appeal" });
  assert.equal(publicEmbedPayload(copy, embed.key)!.payload.funds!.length, before + 1);
  embed.ngoId = "ngo_other";
  assert.equal(publicEmbedPayload(copy, embed.key), null, "another NGO with no funds");
});

test("ticking some funds publishes just those, added together", () => {
  const [a, b, c] = db.funds.filter((f) => f.ngoId === asha.ngoId);
  const two = payloadFor(db, asha.ngoId, { fundId: a.id, fundIds: [a.id, b.id] }, EVERYTHING)!;
  assert.equal(two.scope, "combined");
  assert.deepEqual(two.funds!.map((f) => f.title).sort(), [a.title, b.title].sort());
  assert.ok(!JSON.stringify(two).includes(c.title), "an unticked fund isn't mentioned");
  assert.equal(two.totals!.in, fundStats(db, a).raised + fundStats(db, b).raised);
  // One ticked fund is an ordinary single-fund embed.
  const one = payloadFor(db, asha.ngoId, { fundId: a.id, fundIds: [a.id] }, EVERYTHING)!;
  assert.equal(one.scope, undefined);
  assert.equal(one.fund.title, a.title);
  // Another NGO's fund can't be slipped in.
  assert.equal(payloadFor(db, "ngo_other", { fundId: a.id, fundIds: [a.id, b.id] }, EVERYTHING), null);
});
