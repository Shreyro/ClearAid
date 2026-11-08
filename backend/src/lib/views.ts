import { closurePreview, donorLabel, fundStats, requiredApprovals } from "./funds";
import { activeAssignees, isAssigned, ngoCanSeeFund } from "./session";
import type { DB, Fund, Session, Withdrawal } from "./types";

/** Shape a withdrawal for a given viewer. Raw purpose text and private files never leave the server for the public. */
export function withdrawalView(db: DB, w: Withdrawal, session: Session) {
  const fund = db.funds.find((f) => f.id === w.fundId)!;
  const vendor = db.vendors.find((v) => v.id === w.vendorId);
  const ngoView = ngoCanSeeFund(session, fund);
  const privileged = ngoView;
  const file = (id: string) => db.files.find((f) => f.id === id);
  const files = (ids: string[]) =>
    ids
      .map(file)
      .filter((f) => f && (privileged || f.public))
      .map((f) => ({ id: f!.id, name: f!.name, mime: f!.mime, public: f!.public, exif: f!.exif, url: `/api/files/${f!.id}` }));
  const need = fund.needs.find((n) => n.id === w.needId);
  return {
    id: w.id,
    fundId: w.fundId,
    fundSlug: fund.slug,
    fundTitle: fund.title,
    vendor: vendor ? { id: vendor.id, name: vendor.name, location: vendor.location, verified: vendor.verified } : null,
    amount: w.amount,
    category: w.category,
    need: need ? { id: need.id, item: need.item, unit: need.unit, unitCost: need.unitCost } : null,
    quantity: w.quantity,
    beneficiaries: w.beneficiaries,
    location: w.location,
    purpose: w.purposePublic,
    purposeRaw: privileged ? w.purposeRaw : undefined,
    piiFound: w.piiFound,
    status: w.status,
    audit: w.audit,
    approvals: w.approvals.map((a) => ({ name: a.name, decision: a.decision, note: a.note, at: a.at, by: ngoView ? a.by : undefined })),
    requiredApprovals: requiredApprovals(fund, w),
    /** NGO-only: who may sign, and whether the viewer is one of them. */
    signing: ngoView
      ? {
          youAreAssigned: isAssigned(fund, session.id),
          approvers: activeAssignees(db, fund).map((m) => ({ id: m.id, name: m.name })),
        }
      : undefined,
    payout: w.payout,
    receipts: files(w.receiptFileIds),
    photos: files(w.photoFileIds),
    hiddenFiles: w.receiptFileIds.length + w.photoFileIds.length - (files(w.receiptFileIds).length + files(w.photoFileIds).length),
    createdAt: w.createdAt,
    paidAt: w.paidAt,
    donorsCharged: w.attribution?.length ?? 0,
  };
}

export type WithdrawalView = ReturnType<typeof withdrawalView>;

export function fundCard(db: DB, f: Fund) {
  const s = fundStats(db, f);
  const ngo = db.ngos.find((n) => n.id === f.ngoId)!;
  return {
    id: f.id,
    slug: f.slug,
    title: f.title,
    region: f.region,
    status: f.status,
    accent: f.accent,
    goal: f.goal,
    startedAt: f.startedAt,
    ngo: { name: ngo.name, verified: ngo.verified },
    raised: s.raised,
    spent: s.spent,
    balance: s.balance,
    donors: s.donors,
    transparency: s.transparency,
    beneficiaries: s.beneficiaries,
    trackingCodes: f.trackingCodes ?? [],
    bankIn: s.bankIn,
    bankOut: s.bankOut,
    demo: f.demo,
  };
}

export function fundDetail(db: DB, f: Fund, session: Session) {
  const ngo = db.ngos.find((n) => n.id === f.ngoId)!;
  const stats = fundStats(db, f);
  const ws = db.withdrawals
    .filter((w) => w.fundId === f.id && (ngoCanSeeFund(session, f) || w.status !== "auditing"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((w) => withdrawalView(db, w, session));
  const donations = db.donations
    .filter((d) => d.fundId === f.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 12)
    .map((d) => {
      const entry = db.ledger.find((l) => l.ref === d.id);
      return { id: d.id, amount: d.amount, at: d.createdAt, by: entry?.actor ?? donorLabel(db.donors.find((x) => x.id === d.donorId)), source: d.source };
    });
  return {
    fund: {
      id: f.id,
      slug: f.slug,
      title: f.title,
      disaster: f.disaster,
      region: f.region,
      lat: f.lat,
      lng: f.lng,
      description: f.description,
      goal: f.goal,
      status: f.status,
      startedAt: f.startedAt,
      closingStartedAt: f.closingStartedAt,
      closedAt: f.closedAt,
      accent: f.accent,
      policy: f.policy,
      needs: f.needs,
      demo: f.demo,
      carryForwardFundId: f.carryForwardFundId,
      trackingCodes: f.trackingCodes ?? [],
    },
    ngo: { id: ngo.id, name: ngo.name, verified: ngo.verified, registration: ngo.registration, description: ngo.description },
    stats,
    withdrawals: ws,
    donations,
    closure: f.status === "closing" ? closurePreview(db, f) : null,
    otherFunds: db.funds.filter((x) => x.id !== f.id && x.status === "active").map((x) => ({ id: x.id, title: x.title, slug: x.slug })),
    insights: f.insights ?? null,
  };
}

export type FundDetail = ReturnType<typeof fundDetail>;
export type FundCard = ReturnType<typeof fundCard>;
