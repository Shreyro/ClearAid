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

export type MemberRole = "admin" | "user";

/** An NGO staff login. Admins manage people, funds and vendors; users work on the funds they're assigned to. */
export interface NgoMember {
  id: string;
  name: string;
  title: string;
  username: string;
  /** scrypt: "salt:hash" in hex. */
  passwordHash: string;
  role: MemberRole;
  active: boolean;
  createdAt: string;
  createdBy?: string;
  /** Set once the password is changed, so the demo credential is no longer advertised. */
  passwordChangedAt?: string;
}

/** A staff member asking to be put on a fund. Someone else (an admin) has to approve it. */
export interface AssignmentRequest {
  id: string;
  fundId: string;
  memberId: string;
  note?: string;
  status: "pending" | "approved" | "declined" | "cancelled";
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface Ngo {
  id: string;
  name: string;
  country: string;
  verified: boolean;
  registration: string;
  paypalEmail: string;
  description: string;
  members: NgoMember[];
  /** Admin-set tracking controls. Missing on older data; see `controlsOf`. */
  controls?: NgoControls;
}

export interface NgoControls {
  /** Cents. Manual tags at or above this need a second person's sign-off. Retags and untags always do. */
  tagApprovalThreshold: number;
  /** Cents. Bank payments at or above this should have a receipt attached. */
  receiptThreshold: number;
  /** Where bank fees with no tracking code are charged. Applies to fees imported after the change. */
  feePolicy: { mode: "unallocated" | "fund"; fundId?: string; category?: Category };
  updatedAt?: string;
  updatedBy?: string;
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
  /** NGO members who may sign this fund's withdrawals. */
  assignees: string[];
  /**
   * Tracking codes (without "#", upper-case, e.g. ["RO1", "ASHA"]). A bank
   * transaction whose description contains "#RO1" or "#ASHA-MED" is tagged to
   * this fund. Codes are unique across the NGO.
   */
  trackingCodes: string[];
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
  | "bank_in"
  | "bank_out"
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
  assignmentRequests: AssignmentRequest[];
  auditLog: AuditEntry[];
  bankAccounts: BankAccount[];
  statementImports: StatementImport[];
  bankTxns: BankTxn[];
}

// ------------------------------------------------------------- Banking ----

/** Saved column mapping for a CSV statement (header names as they appear in the file). */
export interface CsvMapping {
  date: string;
  description: string;
  /** Either one signed amount column, or separate debit (out) / credit (in) columns. */
  amount?: string;
  debit?: string;
  credit?: string;
  reference?: string;
  counterparty?: string;
  type?: string;
  dateFormat: "ymd" | "dmy" | "mdy";
}

export interface BankAccount {
  id: string;
  ngoId: string;
  name: string;
  provider: "csv" | "plaid";
  institution: string;
  /** Last 4 digits, if known. */
  mask?: string;
  currency: "USD";
  status: "active" | "disconnected";
  createdAt: string;
  createdBy: string;
  lastSyncAt?: string;
  csvMapping?: CsvMapping;
  /** Description patterns (case-insensitive substrings) that mark a line as a bank fee, e.g. "SERVICE CHARGE". */
  feePatterns: string[];
  plaid?: {
    itemId: string;
    /** AES-256-GCM encrypted access token. Never sent to the browser. */
    accessTokenEnc: string;
    cursor?: string;
    accounts: { id: string; name: string; mask?: string }[];
    /** Simulated connection used when no Plaid keys are configured. */
    simulated: boolean;
  };
}

export interface StatementImport {
  id: string;
  accountId: string;
  source: "csv" | "plaid_sync";
  fileName?: string;
  fileSha256?: string;
  rows: number;
  imported: number;
  duplicates: number;
  autoTagged: number;
  errors: string[];
  createdAt: string;
  createdBy: string;
}

export interface BankAllocation {
  fundId: string;
  /** Budget category from a sub-code (e.g. "#RO1-MED") or chosen by hand. */
  category?: Category;
  /** Cents, always positive; allocations add up to |txn.amount|. */
  amount: number;
  /** The tracking code that put it here, e.g. "RO1-MED". */
  code?: string;
}

export type BankTxnStatus = "auto_tagged" | "tagged" | "untagged" | "fee_unallocated";

export interface BankTxn {
  id: string;
  accountId: string;
  importId?: string;
  /** Provider ID (Plaid transaction_id or a reference column), if any. */
  externalId?: string;
  /** Stable key used to skip rows already imported. */
  dedupeKey: string;
  date: string;
  /** Cents. Positive = money in, negative = money out. */
  amount: number;
  description: string;
  counterparty?: string;
  typeCode?: string;
  isFee: boolean;
  status: BankTxnStatus;
  allocations: BankAllocation[];
  /** Why it isn't tagged: no code, an unknown code, or codes for different funds. */
  untaggedReason?: string;
  tagSource?: "code" | "manual" | "fee_policy";
  taggedBy?: string;
  taggedByName?: string;
  taggedAt?: string;
  reason?: string;
  /** Set when a second person signed off a manual tag. */
  approvedByName?: string;
  approvedAt?: string;
  /** A manual tag, retag or untag waiting for a second person. Nothing is posted until it's approved. */
  pending?: PendingTag;
  /** Receipts and invoices attached as evidence. They never change the tag. */
  receipts?: BankReceipt[];
  /** Previous allocations, newest last, kept when a transaction is retagged. */
  history: { allocations: BankAllocation[]; by: string; at: string; reason?: string; approvedBy?: string }[];
  createdAt: string;
}

export interface PendingTag {
  kind: "tag" | "retag" | "untag";
  allocations: BankAllocation[];
  reason: string;
  byId: string;
  byName: string;
  at: string;
  /** Why it needs a second person. */
  why: string;
}

export interface BankReceipt {
  fileId: string;
  engine: "claude" | "none";
  extraction?: {
    supplier: string | null;
    invoiceNumber: string | null;
    date: string | null;
    currency: string | null;
    total: number | null;
    printedCode: string | null;
    lineItems: { description: string; amount: number | null }[];
    legible: boolean;
  };
  /** Fixed-rule match against the bank line (amount 50, date 25, supplier 20, invoice no. 5). */
  match: { score: number; signals: string[] };
  /** A tracking code printed on the receipt that disagrees with the line's fund. Flagged only, never applied. */
  codeMismatch?: string;
  note?: string;
  byId: string;
  byName: string;
  at: string;
}

export type AuditAction =
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "member.created"
  | "member.role_changed"
  | "member.password_reset"
  | "member.deactivated"
  | "member.reactivated"
  | "assignment.added"
  | "assignment.removed"
  | "assignment.requested"
  | "assignment.approved"
  | "assignment.declined"
  | "assignment.cancelled"
  | "withdrawal.submitted"
  | "withdrawal.signed"
  | "withdrawal.rejected"
  | "withdrawal.fast_lane"
  | "withdrawal.paid"
  | "withdrawal.payout_failed"
  | "withdrawal.reaudit"
  | "fund.created"
  | "fund.closing_started"
  | "fund.closed"
  | "vendor.created"
  | "vendor.verified"
  | "transaction.recorded"
  | "refund.issued"
  | "export.transactions"
  | "export.audit"
  | "demo.reset"
  | "bank.account_added"
  | "bank.account_disconnected"
  | "bank.account_updated"
  | "bank.imported"
  | "bank.synced"
  | "bank.tagged"
  | "bank.retagged"
  | "bank.tag_requested"
  | "bank.tag_approved"
  | "bank.tag_rejected"
  | "bank.receipt_added"
  | "ngo.controls_updated"
  | "fund.codes_updated";

export interface AuditEntry {
  seq: number;
  ts: string;
  actorId: string;
  actorName: string;
  action: AuditAction;
  fundId?: string;
  targetId?: string;
  summary: string;
  meta?: Record<string, string | number | boolean>;
  prevHash: string;
  hash: string;
}

/** Only NGO staff sign in. Everyone else is signed out ("public") and sees nothing but the sign-in page. */
export interface Session {
  role: "public" | "ngo";
  id?: string;
  /** Set for NGO sessions. */
  memberRole?: MemberRole;
}
