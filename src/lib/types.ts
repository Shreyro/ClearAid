export type Category =
  | "food"
  | "water"
  | "shelter"
  | "medical"
  | "hygiene"
  | "logistics"
  | "cash_aid"
  | "admin";

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: "food", label: "Food" },
  { id: "water", label: "Water & sanitation" },
  { id: "shelter", label: "Shelter" },
  { id: "medical", label: "Medical" },
  { id: "hygiene", label: "Hygiene kits" },
  { id: "logistics", label: "Logistics & transport" },
  { id: "cash_aid", label: "Direct cash aid" },
  { id: "admin", label: "Admin & overhead" },
];

export const categoryLabel = (c: Category) => CATEGORIES.find((x) => x.id === c)?.label ?? c;

export interface Admin {
  id: string;
  name: string;
  title: string;
}

export interface Ngo {
  id: string;
  name: string;
  country: string;
  verified: boolean;
  registration: string;
  paypalEmail: string;
  description: string;
  admins: Admin[];
}

export interface Need {
  id: string;
  item: string;
  category: Category;
  unit: string;
  targetQty: number;
  fulfilledQty: number;
  /** Expected cost per unit, in cents. Used to sanity-check withdrawals. */
  unitCost: number;
}

export interface FundPolicy {
  /** Max share (0-100) of total raised that may be spent per category. */
  categoryCaps: Partial<Record<Category, number>>;
  /** Withdrawals at or above this amount need two different NGO approvers. */
  dualApprovalThreshold: number;
  /** Hard cap on a single withdrawal. */
  maxSingleWithdrawal: number;
  requirePhotos: boolean;
  /** Low-risk withdrawals at or below this amount are auto-approved by the AI fast lane. 0 disables. */
  fastLaneMax: number;
  fastLaneMaxRisk: number;
  /** What happens to a donor's leftover share if they make no choice when the fund closes. */
  leftoverDefault: "refund" | "carry_forward";
}

export type FundStatus = "active" | "closing" | "closed";

export interface FundInsights {
  engine: "claude" | "heuristic";
  generatedAt: string;
  headline: string;
  summary: string;
  highlights: string[];
  gaps: string[];
  risks: string[];
  runwayDays: number | null;
  donorMessage: string;
}

export interface Fund {
  id: string;
  slug: string;
  ngoId: string;
  title: string;
  disaster: string;
  region: string;
  lat: number;
  lng: number;
  startedAt: string;
  description: string;
  goal: number;
  status: FundStatus;
  policy: FundPolicy;
  needs: Need[];
  vendorIds: string[];
  carryForwardFundId?: string;
  closingStartedAt?: string;
  closedAt?: string;
  accent: string;
  insights?: FundInsights;
  demo?: boolean;
}

export interface Donor {
  id: string;
  name: string;
  email: string;
  /** Name shown publicly. Undefined means the donor is listed anonymously. */
  publicName?: string;
  createdAt: string;
}

/** A PayPal capture: the unit that can be refunded. */
export interface Capture {
  id: string;
  orderId: string;
  donorId: string;
  amount: number;
  refunded: number;
  createdAt: string;
  live: boolean;
}

export interface Donation {
  id: string;
  fundId: string;
  donorId: string;
  amount: number;
  source: "paypal" | "carry_forward";
  /** PayPal captures that funded this donation (carry-forwards inherit their parent's). */
  captureIds: string[];
  fromFundId?: string;
  /** Portion already spent on withdrawals (pro-rata attribution). */
  attributed: number;
  refunded: number;
  carriedOut: number;
  createdAt: string;
  election?: { choice: "refund" | "carry_forward"; targetFundId?: string; at: string };
}

export interface Vendor {
  id: string;
  name: string;
  paypalEmail: string;
  category: Category;
  verified: boolean;
  location: string;
  ngoId: string;
  joinedAt: string;
}

export interface StoredFile {
  id: string;
  kind: "receipt" | "photo";
  mime: string;
  name: string;
  size: number;
  sha256: string;
  /** 64-bit perceptual difference hash, hex. Photos only. */
  dhash?: string;
  exif?: { takenAt?: string; lat?: number; lng?: number; device?: string; software?: string };
  /** Public files can be shown on the fund page; private ones only to the NGO. */
  public: boolean;
  createdAt: string;
}

export type CheckStatus = "pass" | "warn" | "fail";

export interface AuditCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  source: "rules" | "ai";
}

export interface ReceiptExtraction {
  vendorName: string | null;
  date: string | null;
  total: number | null;
  currency: string | null;
  lineItems: { description: string; quantity: number | null; amount: number | null }[];
  legible: boolean;
}

export interface PhotoFinding {
  fileId: string;
  depicts: string;
  matchesClaim: boolean;
  estimatedQuantity: number | null;
  containsIdentifiablePeople: boolean;
  concerns: string[];
}

export type Verdict = "approve" | "needs_review" | "reject";

export interface AuditResult {
  engine: "claude" | "heuristic";
  /** True for illustrative audits that ship with the demo seed data. */
  seeded?: boolean;
  model?: string;
  ranAt: string;
  riskScore: number;
  verdict: Verdict;
  summary: string;
  receipt?: ReceiptExtraction;
  photos: PhotoFinding[];
  checks: AuditCheck[];
}

export type WithdrawalStatus =
  | "auditing"
  | "pending_approval"
  | "paid"
  | "rejected"
  | "payout_failed";

export interface Approval {
  by: string;
  name: string;
  decision: "approve" | "reject";
  note?: string;
  at: string;
}

export interface Withdrawal {
  id: string;
  fundId: string;
  vendorId: string;
  amount: number;
  category: Category;
  needId?: string;
  quantity?: number;
  beneficiaries?: number;
  location?: string;
  /** Original text from the vendor. Private: may contain personal data. */
  purposeRaw: string;
  /** PII-redacted text shown publicly. */
  purposePublic: string;
  piiFound: { type: string; count: number }[];
  receiptFileIds: string[];
  photoFileIds: string[];
  status: WithdrawalStatus;
  audit?: AuditResult;
  approvals: Approval[];
  payout?: { batchId: string; status: string; live: boolean; at: string };
  attribution?: { donationId: string; amount: number }[];
  createdAt: string;
  paidAt?: string;
}

export type LedgerType =
  | "fund_opened"
  | "donation"
  | "withdrawal"
  | "withdrawal_rejected"
  | "refund"
  | "carry_forward_out"
  | "carry_forward_in"
  | "dispute_opened"
  | "fund_closing"
  | "fund_closed";

export interface LedgerEntry {
  seq: number;
  fundId: string;
  ts: string;
  type: LedgerType;
  /** Cents. Positive for money in, negative for money out, 0 for notices. */
  amount: number;
  memo: string;
  actor: string;
  ref?: string;
  paypalRef?: string;
  prevHash: string;
  hash: string;
}

export interface PendingOrder {
  orderId: string;
  fundId: string;
  amount: number;
  donorName?: string;
  donorEmail?: string;
  showName: boolean;
  createdAt: string;
  status: "created" | "captured";
}

export interface DB {
  version: number;
  ngos: Ngo[];
  funds: Fund[];
  donors: Donor[];
  captures: Capture[];
  donations: Donation[];
  vendors: Vendor[];
  files: StoredFile[];
  withdrawals: Withdrawal[];
  ledger: LedgerEntry[];
  orders: PendingOrder[];
  processedWebhooks: string[];
}

export interface Session {
  role: "public" | "donor" | "ngo" | "vendor";
  id?: string;
}
