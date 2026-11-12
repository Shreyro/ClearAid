# ClearAid: Business Requirements Document (BRD)

| | |
|---|---|
| Product | ClearAid: financial controls and transparency for relief NGOs on PayPal |
| Document | Business Requirements Document |
| Version | 1.0 (matches `main` at the time of writing) |
| Status | Baseline for the PayPal AI Hackathon submission |
| Related | [High-Level Design](HLD.md) · [Low-Level Design](LLD.md) · [Demo script](DEMO_SCRIPT.md) |

> The demo organisation (Coastal Relief Collective), its funds (Cyclone Asha, Mahanadi floods, Monsoon preparedness), staff, donors and payees are fictional.

---

## 1. Executive summary

Relief NGOs raise money fast after a disaster and spend it fast under pressure. Months later, auditors, boards, grant makers and donors ask the same questions: *where did the money come from, which fund did it go to, who was it paid to, who approved it, and on what evidence?* Today the answers are spread over PayPal exports, bank statements, spreadsheets, WhatsApp photos of receipts and people's memories.

ClearAid is an internal governance, risk and compliance (GRC) tool that turns those scattered records into **one tamper-evident trail per fund**. It pulls money in from PayPal and bank accounts, traces every line to a fund by a tracking code, keeps receipts with the payments they prove, routes risky spending through AI-assisted review and human sign-off, and writes every action to a hash-chained audit log. An admin can then publish exactly the figures they choose to the NGO's website, and nothing else.

All AI runs **on the NGO's own machine** (Ollama + FAISS). No donor, beneficiary or bank data is sent to a cloud AI service.

## 2. Background and problem statement

| # | Problem | Who feels it | Consequence today |
|---|---|---|---|
| P1 | Money arrives through many channels (PayPal, bank transfers, cheques, grants) and isn't tied to a specific appeal | Finance staff | Restricted funds get mixed; reporting per appeal is manual and error-prone |
| P2 | Spending evidence (invoices, receipts, delivery photos) lives outside the books | Finance, auditors | Payments can't be proven; duplicates and inflated invoices go unnoticed |
| P3 | One person can often move money alone | Board, auditors, grant makers | Fraud and error risk; failed audits; lost grants |
| P4 | Records can be edited after the fact | Auditors, regulators | Reports can't be trusted without expensive re-verification |
| P5 | Bank statements and requests contain personal data of beneficiaries and individual donors | Data protection officer, beneficiaries | Privacy breaches when data is shared or published |
| P6 | Donors and the public get glossy reports, not figures they can check | Donors, public | Distrust; giving drops after the first wave |
| P7 | Small NGOs can't afford finance analysts | Leadership | Questions like "what bank money isn't on any fund yet?" go unanswered |

## 3. Business objectives

| ID | Objective | Measure of success |
|---|---|---|
| BO-1 | Every dollar in and out is attributable to a fund | ≥ 95% of bank lines auto-traced by tracking code; the rest visible in one "Untagged" queue |
| BO-2 | Every payment is backed by evidence | "Missing documents" filter shows 0 payments above the receipt threshold |
| BO-3 | No single person can move or reallocate large sums alone | 100% of payouts ≥ the dual-approval threshold carry two different approvers; 100% of large manual tags carry a second sign-off |
| BO-4 | Records are tamper-evident | Ledger and audit-log hash chains verify in the browser with no server trust |
| BO-5 | Personal data never leaves the NGO by accident | 0 personal names, account numbers, phones or emails stored from bank lines; public embeds expose only whitelisted fields |
| BO-6 | Donors can see impact without seeing private data | Published embeds and read-only donor logins show totals, categories and (optionally) registered payees only |
| BO-7 | Staff can ask questions in plain language | Copilot answers with citations, restricted to the funds the person may see, with no data leaving the machine |

## 4. Stakeholders and users

| Stakeholder | Role in ClearAid | Main needs |
|---|---|---|
| **NGO admin** (e.g. Finance Lead) | `admin` login | Full visibility; manage team, funds, tracking codes, controls, payees, PayPal/bank sources, embeds; close funds |
| **NGO staff** (e.g. Field Director, Logistics) | `user` login | Work on assigned funds only: record money in/out, tag bank lines, attach receipts, sign payment requests |
| **Donor** (major donor, grant officer) | `donor` login (read-only) | See where *their* assigned funds' money went, redacted; ask the Copilot |
| **Public / website visitor** | No login | Donate via a fund's link; read figures the admin published as an embed |
| **Payee / vendor** | No login | Gets paid via PayPal; is registered and verified (KYB) by an admin |
| **Auditor / board** | Usually via an admin or donor login, CSV exports | Verify chains, export transactions and the audit log |
| **PayPal** | Payment platform | Orders, captures, refunds, payouts, webhooks, partner onboarding |
| **Plaid** | Bank data aggregator | Bank account linking, transaction sync, webhooks |

## 5. Scope

### 5.1 In scope (this release)

- Multi-fund ledger for one NGO, with tracking codes per fund
- Money in: PayPal donations (hosted donation page per fund and embeddable donate form), bank lines (CSV upload, Plaid), money recorded by staff (cheques, cash, grants)
- Money out: declared payments from a receipt, PayPal payouts sent from ClearAid, bank lines, AI-audited payment requests with dual approval
- Bank-line tagging queue with split, bulk tag, retag and second-person sign-off
- Statement anonymisation on import
- Receipts, invoices and later documents attached to transactions; staff tags
- Hash-chained per-fund ledger and NGO-wide audit log, verifiable in the browser
- Public embeds (iframe + JSON) with block-by-block publishing and live preview
- Read-only donor logins scoped to assigned funds
- Local AI: receipt reading (OCR + LLM), payment-request audit, PII redaction, fund insights, fund drafting, Copilot (RAG over FAISS)
- Fund closure with leftover moves to other funds and optional pro-rata returns to donors who asked
- Deployments: local dev, Docker Compose, Render blueprint

### 5.2 Out of scope (this release)

- Multiple NGOs per deployment with self-service sign-up (data model supports `ngoId`, UI assumes one NGO)
- SSO / MFA (username + password only)
- Non-USD currencies
- Full double-entry accounting, payroll, tax filing
- Vendor self-service portal (requests are logged by staff)
- Production database (single JSON file store)

## 6. Business requirements

Priority: **M** = must, **S** = should, **C** = could.

### 6.1 Access and identity

| ID | Requirement | Priority |
|---|---|---|
| BR-AC-1 | Only signed-in NGO members can see anything other than a fund's donation page and published embeds | M |
| BR-AC-2 | Three roles: admin (everything), staff (assigned funds only), donor (read-only, admin-assigned funds, redacted) | M |
| BR-AC-3 | Staff ask to join a fund; someone other than the requester approves | M |
| BR-AC-4 | Admins create logins, change roles, reset passwords (signing the person out everywhere) and deactivate accounts | M |
| BR-AC-5 | Donor logins can never change anything; new features are closed to donors by default | M |
| BR-AC-6 | Admins decide which staff may send PayPal payments | S |

### 6.2 Money in

| ID | Requirement | Priority |
|---|---|---|
| BR-IN-1 | Each fund has a public donation link that pays via PayPal into the PayPal account chosen for that fund | M |
| BR-IN-2 | Donations are recorded on the fund's ledger the moment PayPal captures them, and confirmed by verified webhooks | M |
| BR-IN-3 | Donors may choose to be listed by name or anonymously | M |
| BR-IN-4 | Where a fund allows it, donors may ask for their share of any leftover back when the fund closes | S |
| BR-IN-5 | Bank statements can be uploaded as CSV with auto-detected columns; the mapping is remembered; duplicate files and rows are skipped | M |
| BR-IN-6 | Banks can be connected live through Plaid with automatic sync (webhook + timer) and re-login handling | S |
| BR-IN-7 | Staff can record money received outside PayPal and the bank feed (cheque, cash, grant) with a reference | M |
| BR-IN-8 | The NGO can connect several PayPal accounts (by API keys or by logging in through PayPal's partner onboarding) | S |
| BR-IN-9 | PayPal balance withdrawn to the bank is recognised as a transfer, not new money | S |

### 6.3 Tracing money to funds

| ID | Requirement | Priority |
|---|---|---|
| BR-TR-1 | Each fund has one or more unique tracking codes (e.g. `#RO1`, `#ASHA`) and optional category suffixes (`#RO1-MED`) | M |
| BR-TR-2 | A bank line whose description carries exactly one fund's code is posted to that fund automatically | M |
| BR-TR-3 | Lines with no code, an unknown code or codes for two funds wait in an "Untagged" queue | M |
| BR-TR-4 | Staff tag, split, bulk-tag or retag a line with a mandatory reason; tagging never uses AI | M |
| BR-TR-5 | Manual tags at or above an admin-set threshold, and every retag or untag, need a second person's sign-off before reaching the ledger | M |
| BR-TR-6 | Bank fees follow an admin-set policy (stay unallocated, or charge a chosen fund/category) | S |

### 6.4 Money out and evidence

| ID | Requirement | Priority |
|---|---|---|
| BR-OUT-1 | Staff record a payment by uploading its receipt; local AI reads supplier, invoice number, date, total, line items and any printed tracking code, and the person confirms | M |
| BR-OUT-2 | A declared bank/card/cheque payment is matched to its bank line when it arrives, so it is counted once | M |
| BR-OUT-3 | Declared payments can be unlinked or voided with a reason; history is never rewritten | M |
| BR-OUT-4 | Staff can send a PayPal payout from a fund to a registered payee or any PayPal email, limited by the fund's available balance | S |
| BR-OUT-5 | Payment requests carry a receipt and proof-of-delivery photos and are checked by deterministic rules and a local AI audit | M |
| BR-OUT-6 | Only people assigned to a fund can sign its payment requests; requests at or above the dual-approval threshold need two different approvers | M |
| BR-OUT-7 | Clean, low-risk requests under a per-fund limit may be auto-approved by the AI fast lane; a failed rule check is never auto-approved | S |
| BR-OUT-8 | Payouts go only to payees an admin has verified | M |
| BR-OUT-9 | Any transaction can later get staff tags and attached documents; "Missing documents" lists money out with no paperwork | M |
| BR-OUT-10 | Bank payments at or above an admin-set amount should have a receipt | S |

### 6.5 Integrity, audit and reporting

| ID | Requirement | Priority |
|---|---|---|
| BR-AU-1 | Every money movement is appended to a per-fund SHA-256 hash chain; entries are never edited or deleted | M |
| BR-AU-2 | Every staff and system action (sign-ins, failed sign-ins, tags, approvals, exports, settings, embed changes) is appended to an NGO-wide hash-chained audit log | M |
| BR-AU-3 | Anyone with access can re-verify both chains in their own browser | M |
| BR-AU-4 | Transactions and the audit log export to CSV; exports themselves are audit-logged | M |
| BR-AU-5 | A dashboard shows money in, out, held and not yet traced, and a source → fund → destination flow diagram | M |

### 6.6 Privacy

| ID | Requirement | Priority |
|---|---|---|
| BR-PR-1 | Personal names in bank lines become stable aliases; account/card numbers, UPI IDs, phones, emails and ID numbers are redacted **before storage** | M |
| BR-PR-2 | Free-text descriptions on payment requests are redacted (regex + local AI) for anything shown outside staff | M |
| BR-PR-3 | Photos with identifiable people are kept private | M |
| BR-PR-4 | No data is sent to a cloud AI service | M |

### 6.7 Publishing and donor transparency

| ID | Requirement | Priority |
|---|---|---|
| BR-PB-1 | Nothing is public by default | M |
| BR-PB-2 | An admin builds an embed block by block (totals, channels, categories, payees, flow, timeline, latest movements, integrity proof, donate form), sees a live preview, and publishes | M |
| BR-PB-3 | An embed can cover one fund, several funds, or all funds (including future ones) | S |
| BR-PB-4 | Embeds can be paused or deleted instantly; every change is audit-logged | M |
| BR-PB-5 | Donor identities, staff names, bank references, approvals, receipts and the audit log can never appear in an embed | M |

### 6.8 AI assistance

| ID | Requirement | Priority |
|---|---|---|
| BR-AI-1 | Staff can ask the Copilot where money came from and went, and get answers that cite records | S |
| BR-AI-2 | The Copilot only searches funds the person may see; donors only get redacted passages | M |
| BR-AI-3 | Every AI feature has a non-AI fallback, so the system works with AI switched off | M |
| BR-AI-4 | AI recommends; humans decide | M |

### 6.9 Fund lifecycle

| ID | Requirement | Priority |
|---|---|---|
| BR-FL-1 | Admins create funds (optionally drafted by AI from a short description) with goal, needs, policy and codes | M |
| BR-FL-2 | Closing a fund stops new money, lets the admin move any amount of the leftover to other open funds, and keeps whatever isn't moved tracked on the closed fund | M |
| BR-FL-3 | Donors who asked get `leftover × (their gifts ÷ total raised)` back, as a PayPal refund (gifts < 180 days old) or a payout | S |

## 7. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-1 | Security | Passwords scrypt-hashed; session cookie HMAC-signed and invalidated by password change; stored PayPal secrets and Plaid tokens AES-256-GCM encrypted |
| NFR-2 | Security | Inbound PayPal and Plaid webhooks are signature-verified before they change anything |
| NFR-3 | Privacy | Local-only AI; anonymisation before storage; embed responses built from a whitelist |
| NFR-4 | Integrity | All amounts in integer cents; pro-rata splits by largest remainder so totals always reconcile |
| NFR-5 | Availability | The app runs end to end without PayPal keys, Plaid keys or Ollama (simulated / heuristic modes, clearly labelled) |
| NFR-6 | Usability | Works on phones; embeds fit their host page and support light, dark and auto colours |
| NFR-7 | Performance | Screens update live over server-sent events; the Copilot model stays loaded between questions |
| NFR-8 | Portability | Runs on Node 22 + Python 3.10+, in Docker Compose, or on Render |
| NFR-9 | Testability | Domain logic covered by unit tests (`npm test` in `backend/`); every API route covered by a Postman collection |
| NFR-10 | Cost | Hosted AI service suspends itself when idle (Render) |

## 8. Assumptions and constraints

- One NGO per deployment, USD only, posted bank transactions only.
- A single-instance JSON-file store is acceptable for the hackathon; production would use Postgres.
- PayPal sandbox is used for the demo. Live use of partner (multiparty) onboarding needs PayPal's approval.
- PayPal limits: refunds within 180 days; single payout ≤ $10,000; payouts can't be sent from accounts connected by partner login.
- The local model (Llama 3.1 8B) needs about 6 GB of RAM; a GPU is optional.

## 9. Business risks

| Risk | Likelihood | Impact | Mitigation in ClearAid |
|---|---|---|---|
| AI misreads a receipt | Medium | Medium | Person confirms every field; changed fields are audit-logged; rule checks run independently |
| AI approves a bad payment | Low | High | Fast lane only for clean, low-risk, small, single-signature requests; any failed rule blocks it |
| Insider reallocates money | Medium | High | Second-person sign-off on large tags and every retag; dual approval; immutable chains |
| Data leak through publishing | Low | High | Whitelisted embed response; preview before publish; pause/delete; tests over the whole demo data set |
| Wrong tracking code on a bank line | Medium | Low | Unknown/conflicting codes go to Untagged; receipt codes that disagree are flagged, never applied |
| Lost data on a single server | Medium | High | Back up the data volume; production moves to Postgres with external anchoring of chain heads |

## 10. Acceptance criteria (release)

1. Signing in as each demo role shows only what that role may see (verified by the donor allowlist and fund scoping).
2. Uploading `docs/sample-bank-statement.csv` previews anonymised rows, auto-tags coded lines and queues the rest in Untagged.
3. Tagging a $1,000+ line asks for a second person's sign-off; nothing reaches the ledger before it.
4. Recording a payment from `docs/postman/sample-receipt.png` pre-fills the form from the local AI and posts an `expense` to the ledger.
5. "Verify hash chain" on a fund and "Verify chain" on the audit log both succeed in the browser.
6. A new embed's preview matches the published `/embed/<key>` page, and its JSON contains no donor names, staff names or bank references.
7. The Copilot answers a question about one fund with citations, and refuses a fund the user can't see.
8. `npm test` in `backend/` passes.

## 11. Future scope

- PayPal Multiparty with delayed disbursement per NGO (funds held by PayPal until an approved release)
- SSO and MFA; Postgres; external anchoring of chain heads
- Vendor self-service portal for payment requests
- AI recommendations for what to publish per fund
- Recurring giving and multi-currency

## 12. Glossary

| Term | Meaning |
|---|---|
| Fund | A restricted pot of money for one appeal (e.g. Cyclone Asha) with its own ledger |
| Tracking code | A short code such as `#RO1` written in a payment reference so the money can be traced to a fund |
| Untagged | Bank lines that couldn't be traced to exactly one fund automatically |
| Declared payment | Money out recorded by staff from a receipt, before (or without) its bank line |
| Payment request / withdrawal | A vendor's request to be paid, with receipt and photos, audited and signed before a PayPal payout |
| Fast lane | Auto-approval of clean, low-risk, small payment requests by the AI audit |
| Embed | A read-only public widget (iframe) showing chosen figures for one or more funds |
| Hash chain | A list where each entry stores the SHA-256 hash of the previous one, so edits are detectable |
| Held | Money still in a fund (received − spent − returned) |
