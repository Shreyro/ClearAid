import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "./config";
import { appendLedger } from "./ledger";
import { attribute, donationAvailable, recordDonation } from "./funds";
import { receiptSvg, photoSvg } from "./seed-art";
import type { AuditCheck, Category, DB, Fund, FundPolicy, Need, StoredFile, Vendor, Verdict, Withdrawal } from "./types";
import { categoryLabel } from "./types";
import { hashPassword } from "./password";
import { seedAuditLog } from "./seed-audit";
import { seedBank } from "./seed-bank";

/**
 * Demo NGO sign-ins. They're shown on the sign-in page so judges can try the
 * admin and staff sides. Change or remove them before a real deployment.
 */
export const DEMO_LOGINS = [
  { memberId: "adm_priya", username: "priya", password: "admin-demo", note: "Admin: manages staff, fund assignments, funds and vendors" },
  { memberId: "adm_daniel", username: "daniel", password: "user-demo", note: "Staff: assigned to all three funds" },
  { memberId: "adm_meera", username: "meera", password: "user-demo", note: "Staff: no funds yet, has asked to join Monsoon Preparedness" },
] as const;

/**
 * Demo scenario (fictional events, organisations and people). Timestamps are
 * relative to "now" so the dashboard always looks live.
 */

function prng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86400_000;
const NAMES = [
  "Aarav S.", "Leila K.", "Tomás R.", "Hannah W.", "Kenji M.", "Fatima Z.", "Grace O.", "Noah B.", "Ishaan P.", "Elena V.",
  "Samuel A.", "Mei L.", "Omar H.", "Chloé D.", "Ravi N.", "Amara E.", "Lucas F.", "Ananya G.", "Jonas T.", "Zainab Y.",
  "Diego C.", "Priyanka J.", "Ethan L.", "Nadia Q.", "Kwame A.", "Yuki S.", "Isabella M.", "Arjun K.", "Sara H.", "Felix W.",
  "Aisha B.", "Mateo G.", "Lina R.", "Daniel P.", "Rosa I.", "Vikram D.", "Olivia N.", "Hamza U.", "Freya L.", "Tariq S.",
];
const AMOUNTS = [10, 15, 20, 25, 25, 25, 30, 40, 50, 50, 50, 75, 100, 100, 100, 150, 200, 250, 300, 500];

export function buildSeed(version: number): DB {
  const now = Date.now();
  const rand = prng(20261102);
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
  const iso = (t: number) => new Date(Math.min(t, now - 60_000)).toISOString();

  const db: DB = {
    version,
    ngos: [],
    funds: [],
    donors: [],
    captures: [],
    donations: [],
    vendors: [],
    files: [],
    withdrawals: [],
    ledger: [],
    orders: [],
    processedWebhooks: [],
    assignmentRequests: [],
    auditLog: [],
    bankAccounts: [],
    statementImports: [],
    bankTxns: [],
    embeds: [],
  };

  // ---------------------------------------------------------------- NGO ----
  db.ngos.push({
    id: "ngo_crc",
    name: "Coastal Relief Collective",
    country: "India",
    verified: true,
    registration: "Registered charity · 12A/80G · FCRA 0310-DEMO",
    paypalEmail: "relief@coastalrelief.example",
    description: "A volunteer-led network of 40 community groups delivering food, water and shelter along the Bay of Bengal coast since 2013.",
    members: [
      { id: "adm_priya", name: "Priya Raman", title: "Finance Lead", role: "admin" },
      { id: "adm_daniel", name: "Daniel Okafor", title: "Field Director", role: "user" },
      { id: "adm_meera", name: "Meera Iyer", title: "Logistics Coordinator", role: "user" },
    ].map((m) => {
      const login = DEMO_LOGINS.find((l) => l.memberId === m.id)!;
      return { ...m, role: m.role as "admin" | "user", username: login.username, passwordHash: hashPassword(login.password), active: true, createdAt: iso(now - 120 * DAY) };
    }),
  });

  // ------------------------------------------------------------ Vendors ----
  const vendor = (id: string, name: string, category: Category, location: string, verified = true): Vendor => ({
    id,
    name,
    category,
    location,
    verified,
    ngoId: "ngo_crc",
    paypalEmail: `${id.replace("vnd_", "")}@vendors.example`,
    joinedAt: iso(now - 60 * DAY),
  });
  db.vendors.push(
    vendor("vnd_aquapure", "AquaPure Water Systems", "water", "Bhubaneswar, Odisha"),
    vendor("vnd_kalinga", "Kalinga Rice & Pulses Traders", "food", "Cuttack, Odisha"),
    vendor("vnd_shelterkit", "ShelterKit India", "shelter", "Visakhapatnam, AP"),
    vendor("vnd_medline", "MedLine Pharma Distributors", "medical", "Bhubaneswar, Odisha"),
    vendor("vnd_rapidmove", "RapidMove Logistics", "logistics", "Puri, Odisha"),
    vendor("vnd_cleanhands", "CleanHands Hygiene Supplies", "hygiene", "Berhampur, Odisha"),
    vendor("vnd_quicksupply", "QuickSupply Co.", "shelter", "Kolkata, WB", false),
  );

  // -------------------------------------------------------------- Funds ----
  const policy = (p: Partial<FundPolicy> = {}): FundPolicy => ({
    categoryCaps: { food: 40, water: 25, shelter: 30, medical: 20, hygiene: 20, logistics: 15, cash_aid: 20, admin: 8 },
    dualApprovalThreshold: 250000,
    maxSingleWithdrawal: 600000,
    requirePhotos: true,
    fastLaneMax: 75000,
    fastLaneMaxRisk: 20,
    leftoverDefault: "carry_forward",
    ...p,
  });
  const need = (id: string, item: string, category: Category, unit: string, targetQty: number, unitCost: number): Need => ({
    id,
    item,
    category,
    unit,
    targetQty,
    unitCost,
    fulfilledQty: 0,
  });
  const allVendors = db.vendors.filter((v) => v.verified).map((v) => v.id);

  const asha: Fund = {
    id: "fund_asha",
    slug: "cyclone-asha",
    ngoId: "ngo_crc",
    title: "Cyclone Asha — Coastal Recovery Fund",
    disaster: "Cyclone Asha (fictional demo event)",
    region: "Puri & Ganjam districts, Odisha, India",
    lat: 19.81,
    lng: 85.83,
    startedAt: iso(now - 18 * DAY),
    description:
      "Cyclone Asha made landfall with 180 km/h winds, flattening thatched homes and contaminating wells across 140 coastal villages. This fund buys food rations, safe water, tarpaulin shelters, hygiene kits and clinic supplies from verified local vendors — every payment is receipted, photographed and published here.",
    goal: 6000000,
    status: "active",
    policy: policy(),
    needs: [
      need("n_food", "Family food ration (rice, dal, oil · 7 days)", "food", "rations", 3000, 1600),
      need("n_water", "Safe drinking water (20 L jerrycan)", "water", "jerrycans", 15000, 60),
      need("n_shelter", "Tarpaulin shelter kit", "shelter", "kits", 1200, 2100),
      need("n_hygiene", "Family hygiene kit", "hygiene", "kits", 2500, 850),
      need("n_medical", "Clinic restock kit (ORS, antibiotics, dressings)", "medical", "kits", 60, 23500),
      need("n_trucks", "Truck trips to cut-off villages", "logistics", "trips", 120, 8500),
    ],
    vendorIds: allVendors,
    assignees: ["adm_priya", "adm_daniel"],
    trackingCodes: ["RO1", "ASHA"],
    carryForwardFundId: "fund_monsoon",
    accent: "#0f766e",
    demo: true,
  };
  const monsoon: Fund = {
    id: "fund_monsoon",
    slug: "monsoon-preparedness",
    ngoId: "ngo_crc",
    title: "Monsoon Flood Preparedness 2027",
    disaster: "Seasonal flooding (preparedness)",
    region: "Kendrapara & Jagatsinghpur districts, Odisha",
    lat: 20.5,
    lng: 86.42,
    startedAt: iso(now - 40 * DAY),
    description:
      "Pre-positions hygiene kits, water and boats before next year's monsoon so families are reached in hours, not days. Leftover gifts from closed emergency funds can be carried forward here.",
    goal: 2500000,
    status: "active",
    policy: policy({ fastLaneMax: 50000 }),
    needs: [
      need("m_hygiene", "Pre-positioned hygiene kit", "hygiene", "kits", 2000, 850),
      need("m_water", "Water filter (household)", "water", "filters", 800, 1400),
      need("m_trucks", "Warehouse transfer trips", "logistics", "trips", 40, 8500),
    ],
    vendorIds: allVendors,
    assignees: ["adm_daniel"],
    trackingCodes: ["RO2", "MONSOON"],
    accent: "#4338ca",
    demo: true,
  };
  const mahanadi: Fund = {
    id: "fund_mahanadi",
    slug: "mahanadi-floods",
    ngoId: "ngo_crc",
    title: "Mahanadi Flash Flood Response",
    disaster: "Mahanadi flash floods (fictional demo event)",
    region: "Cuttack & Khordha districts, Odisha",
    lat: 20.46,
    lng: 85.88,
    startedAt: iso(now - 75 * DAY),
    description:
      "Emergency response to flash floods along the Mahanadi. State relief reached the villages sooner than expected, so the response finished under budget. Unspent money is now being returned to donors or carried forward, as each donor chooses.",
    goal: 2000000,
    status: "active",
    policy: policy(),
    needs: [
      need("h_food", "Family food ration (7 days)", "food", "rations", 400, 1600),
      need("h_water", "Safe drinking water (20 L jerrycan)", "water", "jerrycans", 4000, 60),
      need("h_shelter", "Tarpaulin shelter kit", "shelter", "kits", 150, 2100),
      need("h_medical", "Clinic restock kit", "medical", "kits", 8, 23500),
      need("h_trucks", "Truck trips", "logistics", "trips", 10, 8500),
    ],
    vendorIds: allVendors,
    assignees: ["adm_priya", "adm_daniel"],
    trackingCodes: ["RO3", "MAHANADI"],
    carryForwardFundId: "fund_monsoon",
    accent: "#b45309",
    demo: true,
  };
  db.funds.push(asha, monsoon, mahanadi);
  // Monsoon Preparedness has only one approver, so its large withdrawals can't
  // clear dual approval until someone else is put on it. Meera has asked to join.
  db.assignmentRequests.push({
    id: "areq_meera_monsoon",
    fundId: monsoon.id,
    memberId: "adm_meera",
    note: "I run the Kendrapara warehouse, so I can check the pre-positioning deliveries.",
    status: "pending",
    createdAt: iso(now - 5 * 3600_000),
  });

  // ------------------------------------------------------------- Files ----
  const uploads = path.join(config.dataDir, "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  const saveSvg = (kind: StoredFile["kind"], name: string, svg: string, extra: Partial<StoredFile> = {}) => {
    const id = `file_${hex(12)}`;
    fs.writeFileSync(path.join(uploads, id), svg);
    const f: StoredFile = {
      id,
      kind,
      mime: "image/svg+xml",
      name,
      size: Buffer.byteLength(svg),
      sha256: createHash("sha256").update(svg).digest("hex"),
      public: true,
      createdAt: new Date().toISOString(),
      ...extra,
    };
    db.files.push(f);
    return f;
  };

  // ----------------------------------------------------------- Personas ----
  const persona = (id: string, name: string, email: string, publicName?: string) =>
    db.donors.push({ id, name, email, publicName, createdAt: iso(now - 90 * DAY) });
  persona("dnr_maya", "Maya Chen", "maya@example.com", "Maya C.");
  persona("dnr_arjun", "Arjun Mehta", "arjun@example.com");
  persona("dnr_sofia", "Sofia Alvarez", "sofia@example.com", "Sofia A.");
  persona("dnr_brightline", "Brightline Software", "giving@brightline.example", "Brightline Software (employee match)");

  // ---------------------------------------------------------- Timeline ----
  type Ev = { t: number; run: () => void };
  const events: Ev[] = [];
  let order = 0;
  const donate = (fund: Fund, t: number, amount: number, who?: { email: string; name: string; show: boolean }) => {
    const r = rand();
    const name = who?.name ?? NAMES[Math.floor(r * NAMES.length)];
    const show = who ? who.show : rand() < 0.45;
    const email = who?.email ?? `${name.toLowerCase().replace(/[^a-z]/g, "")}${Math.floor(rand() * 90 + 10)}@donors.example`;
    events.push({
      t,
      run: () => {
        order += 1;
        recordDonation(db, {
          fundId: fund.id,
          amount,
          captureId: `SIM-CAP-${hex(10).toUpperCase()}`,
          orderId: `SIM-ORDER-${order.toString().padStart(5, "0")}`,
          live: false,
          donorEmail: email,
          donorName: name,
          showName: show,
          at: iso(t),
        });
      },
    });
  };
  const crowd = (fund: Fund, total: number, days: number) => {
    let sum = 0;
    const start = Date.parse(fund.startedAt);
    while (sum < total) {
      const amt = AMOUNTS[Math.floor(rand() * AMOUNTS.length)] * 100;
      const t = start + 3600_000 + (days * DAY - 2 * 3600_000) * Math.pow(rand(), 1.7);
      donate(fund, t, amt);
      sum += amt;
    }
  };

  const ashaStart = Date.parse(asha.startedAt);
  const mahStart = Date.parse(mahanadi.startedAt);
  const monStart = Date.parse(monsoon.startedAt);

  donate(asha, ashaStart + 5 * 3600_000, 500000, { email: "giving@brightline.example", name: "Brightline Software", show: true });
  donate(asha, ashaStart + 9 * 3600_000, 10000, { email: "maya@example.com", name: "Maya Chen", show: true });
  donate(asha, ashaStart + 30 * 3600_000, 25000, { email: "arjun@example.com", name: "Arjun Mehta", show: false });
  donate(asha, ashaStart + 6 * DAY, 5000, { email: "sofia@example.com", name: "Sofia Alvarez", show: true });
  crowd(asha, 2650000, 18);

  donate(mahanadi, mahStart + 6.5 * DAY, 15000, { email: "maya@example.com", name: "Maya Chen", show: true });
  donate(mahanadi, mahStart + 2 * DAY, 20000, { email: "sofia@example.com", name: "Sofia Alvarez", show: true });
  donate(mahanadi, mahStart + 3 * DAY, 10000, { email: "arjun@example.com", name: "Arjun Mehta", show: false });
  crowd(mahanadi, 1000000, 30);

  donate(monsoon, monStart + 2 * DAY, 100000, { email: "giving@brightline.example", name: "Brightline Software", show: true });
  crowd(monsoon, 520000, 40);

  // -------------------------------------------------------- Withdrawals ----
  const pass = (id: string, label: string, detail: string, source: AuditCheck["source"] = "rules"): AuditCheck => ({ id, label, status: "pass", detail, source });
  const warn = (id: string, label: string, detail: string, source: AuditCheck["source"] = "rules"): AuditCheck => ({ id, label, status: "warn", detail, source });
  const fail = (id: string, label: string, detail: string, source: AuditCheck["source"] = "rules"): AuditCheck => ({ id, label, status: "fail", detail, source });
  const kindOf: Record<Category, Parameters<typeof photoSvg>[0]["kind"]> = {
    food: "food", water: "water", shelter: "shelter", medical: "medical", hygiene: "hygiene", logistics: "logistics", cash_aid: "food", admin: "logistics",
  };
  const photoHashes = new Map<string, { dhash: string; seed: number; stamp: string }>();

  type Spec = {
    fund: Fund;
    vendorId: string;
    day: number;
    needId: string;
    qty: number;
    unit: number;
    purpose: string;
    location: string;
    beneficiaries: number;
    risk: number;
    status: "paid" | "pending_approval" | "rejected";
    approvers?: ("adm_priya" | "adm_daniel" | "ai")[];
    extraChecks?: AuditCheck[];
    verdict?: Verdict;
    summary?: string;
    reusePhotoOf?: string;
    receiptTotalOverride?: number;
    key?: string;
    rejectNote?: string;
  };

  const specs: Spec[] = [
    { key: "a1", fund: asha, vendorId: "vnd_aquapure", day: 2.2, needId: "n_water", qty: 2400, unit: 60, purpose: "Delivered 2,400 jerrycans of treated drinking water to Balukhand relief camp; distribution logged by camp volunteers.", location: "Balukhand relief camp, Puri", beneficiaries: 1800, risk: 12, status: "paid", approvers: ["adm_daniel"] },
    { key: "a2", fund: asha, vendorId: "vnd_kalinga", day: 3.1, needId: "n_food", qty: 220, unit: 1600, purpose: "220 seven-day family rations (rice, dal, oil, salt) for Satapada and Brahmagiri blocks.", location: "Satapada, Puri", beneficiaries: 1100, risk: 18, status: "paid", approvers: ["adm_daniel", "adm_priya"] },
    { key: "a3", fund: asha, vendorId: "vnd_shelterkit", day: 5.0, needId: "n_shelter", qty: 150, unit: 2100, purpose: "150 tarpaulin shelter kits (tarp, rope, poles) for families whose homes were destroyed in Gopalpur.", location: "Gopalpur, Ganjam", beneficiaries: 750, risk: 22, status: "paid", approvers: ["adm_daniel", "adm_priya"] },
    { key: "a4", fund: asha, vendorId: "vnd_rapidmove", day: 6.4, needId: "n_trucks", qty: 18, unit: 8500, purpose: "18 truck trips carrying supplies to villages cut off by road washouts.", location: "Krishnaprasad block, Puri", beneficiaries: 0, risk: 9, status: "paid", approvers: ["adm_priya"] },
    { key: "a5", fund: asha, vendorId: "vnd_cleanhands", day: 8.0, needId: "n_hygiene", qty: 300, unit: 850, purpose: "300 family hygiene kits (soap, sanitary pads, buckets, chlorine) after a diarrhoea outbreak at the school shelter.", location: "Chhatrapur school shelter, Ganjam", beneficiaries: 1500, risk: 15, status: "paid", approvers: ["adm_daniel", "adm_priya"] },
    { key: "a6", fund: asha, vendorId: "vnd_medline", day: 9.5, needId: "n_medical", qty: 6, unit: 23500, purpose: "Restocked 6 mobile clinic kits with ORS, antibiotics and wound dressings.", location: "Mobile clinic route, Puri", beneficiaries: 900, risk: 34, status: "paid", approvers: ["adm_priya"], summary: "Receipt from MedLine Pharma Distributors itemises 6 clinic restock kits at $235.00 each, matching the request. Photos show boxed medical supplies, but they carry no capture time or GPS metadata, so delivery timing could not be independently confirmed. Approved by the NGO after a phone check with the clinic.", extraChecks: [warn("photo_time", "Photo timestamps", "Photos carry no capture time metadata"), warn("photo_geo", "Photo location", "No GPS metadata in the photos")] },
    { key: "a7", fund: asha, vendorId: "vnd_shelterkit", day: 11.2, needId: "n_shelter", qty: 120, unit: 3400, purpose: "120 tarpaulin shelter kits for Gopalpur families.", location: "Gopalpur, Ganjam", beneficiaries: 600, risk: 88, status: "rejected", approvers: ["adm_priya"], reusePhotoOf: "a3", rejectNote: "Photo reused from an earlier delivery and unit price 1.6× expected. Vendor asked to resubmit with new evidence.", verdict: "reject", summary: "The proof photo is a near-identical copy of the photo submitted for an earlier shelter delivery, and the unit price is 62% above the fund's expected cost. Rejected pending new evidence.", extraChecks: [fail("photo_reuse", "Photos are original", "Photo is 97% visually similar to one on an earlier request"), warn("price", "Unit price sanity", "$34/kits is 1.6× the expected $21"), fail("ai_photo", "Photo shows new delivery", "Same tents, same positions and same lighting as the earlier delivery photo", "ai")] },
    { key: "a8", fund: asha, vendorId: "vnd_aquapure", day: 12.3, needId: "n_water", qty: 3000, unit: 60, purpose: "3,000 jerrycans of drinking water for Ganjam coastal villages.", location: "Arjyapalli, Ganjam", beneficiaries: 2100, risk: 11, status: "paid", approvers: ["adm_daniel"] },
    { key: "a9", fund: asha, vendorId: "vnd_rapidmove", day: 13.6, needId: "n_trucks", qty: 5, unit: 8500, purpose: "5 extra truck trips for shelter kit distribution.", location: "Gopalpur, Ganjam", beneficiaries: 0, risk: 8, status: "paid", approvers: ["ai"] },
    { key: "a10", fund: asha, vendorId: "vnd_kalinga", day: 15.0, needId: "n_food", qty: 180, unit: 1600, purpose: "180 family rations for households returning to Satapada.", location: "Satapada, Puri", beneficiaries: 900, risk: 14, status: "paid", approvers: ["adm_daniel", "adm_priya"] },
    { key: "a11", fund: asha, vendorId: "vnd_kalinga", day: 17.2, needId: "n_food", qty: 200, unit: 1600, purpose: "200 family rations for Brahmagiri block; contact for distribution: Mr. Sahu, ph 98610 22457.", location: "Brahmagiri, Puri", beneficiaries: 1000, risk: 14, status: "pending_approval", approvers: ["adm_daniel"] },
    { key: "a12", fund: asha, vendorId: "vnd_medline", day: 17.6, needId: "n_medical", qty: 5, unit: 23600, purpose: "5 clinic restock kits for the Chhatrapur health camp.", location: "Chhatrapur, Ganjam", beneficiaries: 700, risk: 41, status: "pending_approval", approvers: [], receiptTotalOverride: 110500, verdict: "needs_review", summary: "Receipt total ($1,105.00) is 6.4% lower than the $1,180.00 requested and the vendor did not explain the difference. Photos show clinic supplies consistent with the claim. Recommend asking the vendor to correct the amount.", extraChecks: [fail("ai_receipt_match", "Receipt supports amount", "Receipt total ≈ $1,105 vs $1,180 requested", "ai")] },

    { key: "h1", fund: mahanadi, vendorId: "vnd_kalinga", day: 2, needId: "h_food", qty: 325, unit: 1600, purpose: "325 family rations for flood-displaced households.", location: "Cuttack Sadar", beneficiaries: 1600, risk: 16, status: "paid", approvers: ["adm_daniel", "adm_priya"] },
    { key: "h2", fund: mahanadi, vendorId: "vnd_aquapure", day: 3, needId: "h_water", qty: 3500, unit: 60, purpose: "3,500 jerrycans of drinking water.", location: "Banki, Cuttack", beneficiaries: 2000, risk: 10, status: "paid", approvers: ["adm_priya"] },
    { key: "h3", fund: mahanadi, vendorId: "vnd_shelterkit", day: 5, needId: "h_shelter", qty: 140, unit: 2100, purpose: "140 tarpaulin shelter kits.", location: "Athagarh, Cuttack", beneficiaries: 700, risk: 19, status: "paid", approvers: ["adm_daniel", "adm_priya"] },
    { key: "h4", fund: mahanadi, vendorId: "vnd_medline", day: 8, needId: "h_medical", qty: 8, unit: 23500, purpose: "8 clinic restock kits for flood health camps.", location: "Khordha", beneficiaries: 1200, risk: 21, status: "paid", approvers: ["adm_priya"] },
    { key: "h5", fund: mahanadi, vendorId: "vnd_rapidmove", day: 9, needId: "h_trucks", qty: 9, unit: 8500, purpose: "9 truck trips to marooned villages.", location: "Banki, Cuttack", beneficiaries: 0, risk: 9, status: "paid", approvers: ["adm_daniel"] },

    { key: "m1", fund: monsoon, vendorId: "vnd_cleanhands", day: 12, needId: "m_hygiene", qty: 240, unit: 850, purpose: "240 hygiene kits pre-positioned in the Kendrapara warehouse.", location: "Kendrapara warehouse", beneficiaries: 0, risk: 13, status: "paid", approvers: ["adm_priya"] },
  ];

  const byKey = new Map<string, Withdrawal>();
  for (const sp of specs) {
    const t = Date.parse(sp.fund.startedAt) + sp.day * DAY;
    events.push({
      t,
      run: () => {
        const v = db.vendors.find((x) => x.id === sp.vendorId)!;
        const nd = sp.fund.needs.find((n) => n.id === sp.needId)!;
        const amount = sp.qty * sp.unit;
        const date = new Date(t - 3 * 3600_000).toISOString().slice(0, 10);
        const receipt = saveSvg(
          "receipt",
          `invoice-${sp.key}.svg`,
          receiptSvg({
            vendor: v.name,
            address: v.location,
            gst: `21AAB${hex(5).toUpperCase()}1Z${Math.floor(rand() * 9)}`,
            invoiceNo: `INV-${Math.floor(rand() * 9000 + 1000)}`,
            date,
            billTo: "Coastal Relief Collective (ClearAid fund)",
            items: sp.receiptTotalOverride
              ? [{ desc: nd.item.slice(0, 30), qty: sp.qty, unit: sp.receiptTotalOverride / sp.qty / 100 }]
              : [{ desc: nd.item.slice(0, 30), qty: sp.qty, unit: sp.unit / 100 }],
          }),
        );
        const lat = sp.fund.lat + (rand() - 0.5) * 0.3;
        const lng = sp.fund.lng + (rand() - 0.5) * 0.3;
        const stamp = `${new Date(t - 5 * 3600_000).toISOString().slice(0, 16).replace("T", " ")} · ${lat.toFixed(4)}N ${lng.toFixed(4)}E`;
        const photos: StoredFile[] = [];
        const nPhotos = sp.status === "rejected" ? 1 : 2;
        for (let i = 0; i < nPhotos; i++) {
          const reuse = sp.reusePhotoOf && i === 0 ? photoHashes.get(sp.reusePhotoOf) : undefined;
          const dhash = reuse ? reuse.dhash.replace(/^./, (c) => ((parseInt(c, 16) ^ 3) & 15).toString(16)) : hex(16);
          const seed = reuse ? reuse.seed : Math.floor(rand() * 1e6);
          const ph = saveSvg(
            "photo",
            `delivery-${sp.key}-${i + 1}.svg`,
            photoSvg({ kind: kindOf[nd.category], caption: `${v.name} · ${sp.location}`, stamp: reuse ? reuse.stamp : stamp, seed }),
            { dhash, exif: sp.key === "a6" ? undefined : { takenAt: new Date(t - 5 * 3600_000).toISOString(), lat, lng, device: "Pixel 8a" } },
          );
          if (i === 0 && !reuse) photoHashes.set(sp.key!, { dhash, seed, stamp });
          photos.push(ph);
        }
        const base: AuditCheck[] = [
          pass("vendor", "Vendor verified", `${v.name} is a verified vendor for this fund`),
          pass("balance", "Funds available", "Sufficient balance at time of request"),
          pass("limit", "Single-withdrawal limit", "Within the $6,000 limit"),
          pass("cap", "Category budget", `${categoryLabel(nd.category)} within its cap`),
          pass("receipt_dup", "Receipt is unique", "Receipt not seen on any other request"),
          pass("photos", "Proof-of-delivery photos", `${nPhotos} photos attached`),
          pass("photo_geo", "Photo location", "Taken within 25 km of the affected area"),
          pass("ai_receipt_match", "Receipt supports amount", "Receipt total matches the requested amount", "ai"),
          pass("ai_photo", "Photo shows claimed goods", `Photos show ${nd.unit} consistent with the claim`, "ai"),
          pass("ai_price", "Prices plausible", "Unit prices in line with local market rates for relief goods", "ai"),
        ];
        const checks = base
          .filter((c) => !(sp.extraChecks ?? []).some((x) => x.id === c.id))
          .concat(sp.extraChecks ?? [])
          .concat(sp.reusePhotoOf ? [] : [pass("photo_reuse", "Photos are original", "No visual match with any earlier proof photo")]);
        const raw = sp.purpose;
        const redacted = raw.replace("Mr. Sahu", "[NAME]").replace("98610 22457", "[PHONE]");
        const w: Withdrawal = {
          id: `wd_${hex(12)}`,
          fundId: sp.fund.id,
          vendorId: sp.vendorId,
          amount,
          category: nd.category,
          needId: nd.id,
          quantity: sp.qty,
          beneficiaries: sp.beneficiaries || undefined,
          location: sp.location,
          purposeRaw: raw,
          purposePublic: redacted,
          piiFound: raw === redacted ? [] : [{ type: "NAME", count: 1 }, { type: "PHONE", count: 1 }],
          receiptFileIds: [receipt.id],
          photoFileIds: photos.map((p) => p.id),
          status: sp.status,
          approvals: [],
          createdAt: iso(t - 4 * 3600_000),
          audit: {
            engine: "claude",
            seeded: true,
            model: config.claudeModel,
            ranAt: iso(t - 3.9 * 3600_000),
            riskScore: sp.risk,
            verdict: sp.verdict ?? "approve",
            summary:
              sp.summary ??
              `Receipt from ${v.name} itemises ${sp.qty.toLocaleString()} ${nd.unit} at $${(sp.unit / 100).toFixed(2)} each, matching the request. Delivery photos show the goods at ${sp.location} with timestamps and GPS inside the affected area.`,
            receipt: {
              vendorName: v.name,
              date,
              total: (sp.receiptTotalOverride ?? amount) / 100,
              currency: "USD",
              lineItems: [{ description: nd.item, quantity: sp.qty, amount: (sp.receiptTotalOverride ?? amount) / 100 }],
              legible: true,
            },
            photos: photos.map((p) => ({
              fileId: p.id,
              depicts: `${categoryLabel(nd.category)} supplies (${nd.unit}) stacked for distribution`,
              matchesClaim: !sp.reusePhotoOf,
              estimatedQuantity: null,
              containsIdentifiablePeople: false,
              concerns: sp.reusePhotoOf ? ["Near-identical to a photo from an earlier delivery"] : [],
            })),
            checks,
          },
        };
        (sp.approvers ?? []).forEach((a, i) => {
          const admin = db.ngos[0].members.find((x) => x.id === a);
          const decision = sp.status === "rejected" ? "reject" : "approve";
          w.approvals.push({
            by: a,
            name: a === "ai" ? "ClearAid AI fast lane" : admin!.name,
            decision,
            note: a === "ai" ? `Risk ${sp.risk}/100, under $750` : decision === "reject" ? sp.rejectNote : undefined,
            at: iso(t - (3 - i) * 3600_000),
          });
        });
        db.withdrawals.push(w);
        byKey.set(sp.key!, w);

        if (sp.status === "paid") {
          // Early in a crisis, institutional grants often land before the crowd does.
          const unspent = db.donations.filter((d) => d.fundId === sp.fund.id).reduce((a, d) => a + donationAvailable(d), 0);
          if (unspent < amount) {
            order += 1;
            recordDonation(db, {
              fundId: sp.fund.id,
              amount: Math.ceil((amount - unspent + 50000) / 100000) * 100000,
              captureId: `SIM-CAP-${hex(10).toUpperCase()}`,
              orderId: `SIM-ORDER-${order.toString().padStart(5, "0")}`,
              live: false,
              donorEmail: "grants@tidewater-foundation.example",
              donorName: "Tidewater Foundation (grant)",
              showName: true,
              at: iso(t - 6 * 3600_000),
            });
          }
          w.paidAt = iso(t);
          w.payout = { batchId: `SIM-PAYOUT-${hex(10).toUpperCase()}`, status: "SUCCESS", live: false, at: iso(t) };
          w.attribution = attribute(db, sp.fund.id, amount);
          nd.fulfilledQty += sp.qty;
          appendLedger(db, {
            fundId: sp.fund.id,
            type: "withdrawal",
            amount: -amount,
            memo: `${categoryLabel(nd.category)}: ${w.purposePublic}`,
            actor: v.name,
            ref: w.id,
            paypalRef: w.payout.batchId,
            ts: iso(t),
          });
        } else if (sp.status === "rejected") {
          appendLedger(db, {
            fundId: sp.fund.id,
            type: "withdrawal_rejected",
            amount: 0,
            memo: `Request for $${(amount / 100).toLocaleString()} rejected after review: ${sp.rejectNote}`,
            actor: v.name,
            ref: w.id,
            ts: iso(t),
          });
        }
      },
    });
  }

  // fund_opened entries first, then chronological replay.
  for (const f of db.funds) {
    events.push({
      t: Date.parse(f.startedAt) - 60_000,
      run: () =>
        appendLedger(db, {
          fundId: f.id,
          type: "fund_opened",
          amount: 0,
          memo: `Fund opened by Coastal Relief Collective. Goal $${(f.goal / 100).toLocaleString()}.`,
          actor: "Coastal Relief Collective",
          ts: new Date(Date.parse(f.startedAt) - 60_000).toISOString(),
        }),
    });
  }

  // Mahanadi enters its closing window two days ago.
  events.push({
    t: now - 2 * DAY,
    run: () => {
      mahanadi.status = "closing";
      mahanadi.closingStartedAt = iso(now - 2 * DAY);
      const left = db.donations.filter((d) => d.fundId === mahanadi.id).reduce((a, d) => a + donationAvailable(d), 0);
      appendLedger(db, {
        fundId: mahanadi.id,
        type: "fund_closing",
        amount: 0,
        memo: `Response phase complete. $${(left / 100).toFixed(2)} unspent will be refunded or carried forward according to each donor's choice.`,
        actor: "Coastal Relief Collective",
        ts: iso(now - 2 * DAY),
      });
      // A few donors have already chosen.
      const ds = db.donations.filter((d) => d.fundId === mahanadi.id);
      ds.forEach((d, i) => {
        if (d.donorId === "dnr_sofia") d.election = { choice: "carry_forward", targetFundId: "fund_monsoon", at: iso(now - DAY) };
        else if (d.donorId !== "dnr_maya" && d.donorId !== "dnr_arjun" && i % 5 === 1) d.election = { choice: "refund", at: iso(now - DAY) };
        else if (d.donorId !== "dnr_maya" && d.donorId !== "dnr_arjun" && i % 5 === 2) d.election = { choice: "carry_forward", targetFundId: "fund_asha", at: iso(now - DAY) };
      });
    },
  });

  events.sort((a, b) => a.t - b.t).forEach((e) => e.run());
  void byKey;
  seedBank(db, now);
  seedAuditLog(db, now);
  return db;
}
