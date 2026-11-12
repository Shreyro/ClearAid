# ClearAid: High-Level Design (HLD)

| | |
|---|---|
| Document | High-Level Design |
| Version | 1.0 (matches `main`) |
| Related | [BRD](BRD.md) · [Low-Level Design](LLD.md) · [Demo script](DEMO_SCRIPT.md) |

---

## 1. Purpose

This document describes ClearAid's architecture: the components, how they talk to each other and to PayPal, Plaid and the local AI, how data flows through the system, and the main design decisions. Module internals, data structures, algorithms and the API are in the [LLD](LLD.md).

## 2. System context

```mermaid
flowchart LR
  subgraph People
    A[NGO admin]
    S[NGO staff]
    D[Donor login<br/>read-only]
    V[Website visitor /<br/>donor]
  end
  subgraph ClearAid
    W[Web UI<br/>Next.js]
    API[API<br/>Hono on Node 22]
    AI[Local AI<br/>Ollama + rag service]
  end
  NGO[NGO website]
  PP[(PayPal<br/>Orders · Payouts · Refunds ·<br/>Webhooks · Partner Referrals)]
  PL[(Plaid<br/>Link · Transactions Sync ·<br/>Webhooks)]
  BANK[CSV bank statements]

  A & S & D --> W
  V -->|/give/&lt;fund&gt;| W
  NGO -->|iframe /embed/&lt;key&gt;| W
  W -->|/api/* proxy| API
  API --> AI
  API <-->|REST + verified webhooks| PP
  API <-->|REST + signed webhooks| PL
  S -->|upload| BANK --> API
  V -->|PayPal JS SDK| PP
```

**Actors**

- **Admins and staff** run the NGO's finances in the web UI.
- **Donor logins** are read-only and see only the funds an admin assigned them, in redacted form.
- **Visitors** see only two kinds of page without signing in: a fund's donation page (`/give/<fund>`) and embeds an admin has published (`/embed/<key>`).
- **PayPal** takes donations, sends payouts and refunds, and notifies ClearAid by webhook.
- **Plaid** connects bank accounts and pushes "new transactions ready" webhooks.

## 3. Architecture overview

ClearAid has three runtime services and one optional piece:

| Service | Tech | Port | Responsibility |
|---|---|---|---|
| **web** | Next.js 16 (App Router, React 19, Tailwind 4, AG Grid, AG Charts) | 3000 | All screens; proxies `/api/*` to the API so the browser uses one origin and one cookie |
| **backend (API)** | Hono on Node 22, TypeScript, Zod | 4000 | Business logic, auth, ledger and audit chains, PayPal/Plaid integration, AI orchestration, JSON store, server-sent events |
| **rag** | Python 3 (standard-library HTTP server), FAISS, NumPy, EasyOCR, PyMuPDF | 8790 | Vector search for the Copilot (`/sync`, `/search`) and OCR of receipts (`/ocr`) |
| **ollama** | Ollama | 11434 | Local models: `llama3.1:8b` (chat and structured outputs), `nomic-embed-text` (embeddings), `llava` (images only) |
| *tunnel* (optional) | Cloudflare quick tunnel | n/a | A public HTTPS address for PayPal/Plaid webhooks and OAuth redirects on a local machine |

```mermaid
flowchart TB
  subgraph Browser
    UI[Pages: Money flow · Transactions · Untagged · Funds ·<br/>Sources · Audit log · Settings · Copilot]
    PUB[Public: /give/&lt;fund&gt; · /embed/&lt;key&gt;]
    VER[WebCrypto chain verifier]
  end
  subgraph web [web · Next.js :3000]
    RW[rewrite /api/* → backend]
  end
  subgraph api [backend · Hono :4000]
    GATE[Auth gate<br/>open routes · session · donor allowlist]
    ROUTES[Route handlers<br/>src/routes/**/route.ts]
    LIB[Domain library<br/>funds · ledger · audit · banking · payments ·<br/>embed · returns · transfers · anonymise · checks]
    AIL[AI layer<br/>ai/local · ai/ocr · ai/audit · ai/redact ·<br/>ai/insights · rag/copilot]
    INT[Integrations<br/>paypal · paypal-partner · paypal-pay · plaid · bank-sync]
    STORE[(JSON store<br/>db.json + uploads/)]
    BUS[Event bus → SSE /api/stream]
    JOBS[Background: index sync ·<br/>Plaid timer · AI power]
  end
  subgraph ai [Local AI]
    RAG[rag/server.py :8790<br/>FAISS · OCR]
    OLL[Ollama :11434]
  end
  UI & PUB --> RW --> GATE --> ROUTES --> LIB
  ROUTES --> AIL --> OLL
  AIL --> RAG --> OLL
  ROUTES --> INT
  LIB --> STORE
  LIB --> BUS --> UI
  JOBS --> RAG
  JOBS --> INT
  VER -.reads ledger / audit JSON.-> RW
```

### 3.1 Layers inside the API

1. **Gate** (`src/server.ts`). Every route is classed as open (sign-in, donation pages, published embeds, webhooks) or protected. Protected routes need a valid NGO session. Donor sessions are checked against an explicit allowlist of method + path pairs, so any new route is closed to donors by default.
2. **Route handlers** (`src/routes/**/route.ts`). These are thin: they parse input, check fund-level access, call the domain library and shape the response.
3. **Domain library** (`src/lib/*`). This holds all rules: ledger and audit appends, tagging, matching, attribution, closure, returns, embeds, anonymisation and rule checks. Changes go through one `mutate()` call that persists atomically.
4. **AI layer** (`src/lib/ai/*`, `src/lib/rag/*`). Calls Ollama with JSON-schema-constrained outputs, validates them with Zod, and always has a non-AI fallback.
5. **Integrations** (`paypal*.ts`, `plaid.ts`, `bank-sync.ts`). Each runs live with keys, or simulated without them (IDs prefixed `SIM-`).

## 4. Key flows

### 4.1 Donation via PayPal

```mermaid
sequenceDiagram
  participant V as Visitor
  participant W as /give/<fund> or embed
  participant A as API
  participant P as PayPal
  V->>W: Choose amount, name visibility, (opt-in to leftover return)
  W->>A: POST /api/give/:slug/order
  A->>P: POST /v2/checkout/orders (fund's PayPal account, tracking code in reference)
  P-->>W: order id → PayPal buttons
  V->>P: Approve payment
  W->>A: POST /api/give/:slug/capture
  A->>P: POST /v2/checkout/orders/{id}/capture
  A->>A: Donor + capture + donation, ledger "donation" (hash-chained)
  A-->>W: SSE event → dashboards update live
  P-->>A: Webhook PAYMENT.CAPTURE.COMPLETED (verified, idempotent)
```

### 4.2 Bank money: import, trace, tag

```mermaid
flowchart LR
  CSV[CSV upload] --> P[Parse + map columns]
  PLAID[Plaid sync<br/>webhook · timer · button] --> P
  P --> ANON[Anonymise<br/>names → Person-XXXXXX<br/>accounts/phones/emails → placeholders]
  ANON --> DEDUPE{Duplicate?}
  DEDUPE -- yes --> SKIP[skip]
  DEDUPE -- no --> XFER{PayPal transfer<br/>into linked bank?}
  XFER -- yes --> T[status: transfer<br/>never on a fund]
  XFER -- no --> MATCH{Matches a declared<br/>payment waiting<br/>for its bank line?}
  MATCH -- yes --> M[status: matched<br/>not posted again]
  MATCH -- no --> FEE{Bank fee?}
  FEE -- yes --> FP[fee policy]
  FEE -- no --> CODE{Tracking codes<br/>for exactly one fund?}
  CODE -- yes --> AUTO[auto_tagged<br/>ledger bank_in / bank_out]
  CODE -- no --> Q[Untagged queue]
  Q --> H[Staff tag / split / bulk-tag<br/>with reason]
  H --> TH{≥ threshold or<br/>retag/untag?}
  TH -- yes --> SO[Second person signs off] --> L[Ledger]
  TH -- no --> L
```

### 4.3 Recording a payment from its receipt

```mermaid
sequenceDiagram
  participant S as Staff
  participant A as API
  participant R as rag /ocr
  participant O as Ollama
  S->>A: POST /api/payments/scan (image or PDF)
  A->>R: OCR (EasyOCR / PDF text layer)
  R-->>A: text lines
  A->>O: text → JSON fields (supplier, invoice no., date, total, line items)
  A->>A: Fixed rules: tracking code only from printed text, date sanity, total fallback
  A-->>S: Pre-filled form
  S->>A: POST /api/payments (confirmed / corrected fields)
  A->>A: Ledger "expense", audit log notes changed fields
  Note over A: bank_transfer / card / cheque → waits for its bank line<br/>matched later by amount + date window (−3/+21 days)
```

### 4.4 Payment request audit and approval

```mermaid
sequenceDiagram
  participant S as Staff
  participant A as API
  participant O as Ollama (vision)
  participant AP as Approvers
  participant P as PayPal
  S->>A: POST /api/withdrawals (amount, payee, receipt, photos + dHash/EXIF)
  A->>A: Regex PII redaction (immediate)
  A-->>S: 200 (auditing)
  A->>O: Local AI redaction
  A->>A: Rule checks (payee verified, balance, limit, category cap,<br/>unit price, duplicate receipt, photo reuse, time, GPS)
  A->>O: Vision audit → risk, verdict, receipt fields, photo findings
  alt clean, low risk, under fast-lane limit, 1 signature needed
    A->>A: AI fast-lane approval (audit-logged)
  else
    AP->>A: POST /api/withdrawals/:id/decision (assigned approvers, 2 if ≥ threshold)
  end
  A->>P: POST /v1/payments/payouts → verified payee
  A->>A: Ledger "withdrawal", pro-rata attribution to donations
  P-->>A: Payout item webhooks
```

### 4.5 Copilot (local retrieval-augmented answers)

```mermaid
sequenceDiagram
  participant U as User
  participant A as API
  participant R as rag (FAISS)
  participant O as Ollama
  Note over A,R: On every data change: build documents per fund × audience<br/>(staff / redacted public) → POST /sync (only new text is embedded)
  U->>A: POST /api/copilot {message, fundId?, chatId?}
  A->>A: scopeFor(session): which funds + which audience
  A->>A: Narrow to funds named in the question (refuse ones out of scope)
  A->>R: POST /search (only the allowed indexes)
  A->>A: Keyword pass + exact per-fund totals from the ledger
  A->>O: Prompt with passages + totals, answer only from them
  O-->>A: Answer
  A-->>U: Answer with citations, saved to the chat history
```

### 4.6 Public embed

```mermaid
sequenceDiagram
  participant Ad as Admin
  participant A as API
  participant H as Host website
  participant E as /embed/<key>
  Ad->>A: POST /api/embeds/preview (publish switches)
  A-->>Ad: Exactly the public payload
  Ad->>A: POST /api/embeds (create) → key, audit-logged
  H->>E: <iframe src=/embed/KEY>
  E->>A: GET /api/embed/KEY (no cookies, CORS open)
  A-->>E: Only the switched-on blocks (404 if paused/deleted/unknown)
  E-->>H: postMessage(height) → embed.js resizes the frame
```

## 5. Data architecture

- **Store.** One JSON document (`DATA_DIR/db.json`) plus an `uploads/` folder for receipts, photos and documents. It is loaded once into memory. Every change runs through `mutate(fn)`, which writes a temp file and renames it (an atomic write) and then notifies listeners (Copilot index sync, SSE).
- **Concurrency.** Single process. Money-moving async work (payouts, returns) is serialised per fund with `withLock("fund:<id>")`, so balances can't race.
- **Main entities.** NGO and members, funds (policy, needs, codes, viewers), donors, captures, donations, payees (vendors), files, withdrawals, ledger entries, audit entries, bank accounts, statement imports, bank lines, declared payments, PayPal accounts, embeds, donor returns, transaction tags and metadata, Copilot chats. See the [LLD data model](LLD.md#3-data-model).
- **Immutability.** Ledger and audit entries are append-only hash chains. Corrections are new entries (reversals, voids, retags). Tags and documents added later live beside the ledger (`entryMeta`), never inside it.
- **Money.** Integer cents (USD). Pro-rata splits use the largest-remainder method so parts always add up exactly.
- **AI indexes.** FAISS `IndexFlatIP` over L2-normalised `nomic-embed-text` vectors, one index per fund and audience, kept on disk by the rag service, plus an embedding cache keyed by text hash.

## 6. Security architecture

| Concern | Design |
|---|---|
| Authentication | Username + password (scrypt). Cookie `clearaid_persona = ngo:<memberId>:<HMAC>`, signed with `SESSION_SECRET` over the member id and password-change time, so a password reset signs the person out everywhere. `Secure` when served over HTTPS |
| Authorisation | Gate in `server.ts` (open routes, NGO session, donor allowlist), then fund-level checks in handlers (`requireFundAccess`, `isAssigned`, admin-only actions) |
| Segregation of duties | Join requests approved by someone else; dual approval of payment requests; second-person sign-off on large manual tags and every retag; the same person can't sign twice |
| Secrets at rest | PayPal REST secrets and Plaid access tokens are AES-256-GCM encrypted with a key derived from the session secret and never sent to the browser |
| Webhooks | PayPal: `verify-webhook-signature` per account (or the partner app), with processed IDs stored for idempotency. Plaid: ES256 JWT, body SHA-256 and a 5-minute window |
| Privacy | Bank lines anonymised before storage (keyed-hash aliases); payment-request text redacted (regex + local AI); photos with faces kept private; AI is local only |
| Publishing | Embed responses are built from a whitelist of blocks. Donor, staff, bank-reference and audit data are never included (covered by `embed.test.ts` over the whole demo data set). Unknown, paused and deleted keys all return the same 404 |
| Tamper evidence | SHA-256 hash chains for each fund's ledger and the NGO audit log, re-verified in the browser with WebCrypto |
| Internal service auth | Optional shared `RAG_TOKEN` between the API and the rag service. In Docker only the web UI is published; the API, rag and Ollama sit on a private network |

## 7. Deployment views

### 7.1 Local development

```
Browser ─► Next.js dev :3000 ─► Hono API :4000 ─► rag/server.py :8790 ─► Ollama :11434
                                     └─► .data/db.json, .data/uploads/
```

### 7.2 Docker Compose (`docker-compose.yml`)

| Service | Profile | Network | Volume |
|---|---|---|---|
| `web` | always | edge + internal, port `WEB_PORT` published | none |
| `backend` | always | internal | `clearaid-data` (db.json, uploads, session secret) |
| `rag` | always | internal | `clearaid-rag` (FAISS indexes, embedding cache) |
| `ollama`, `models-embed`, `models-chat`, `models-vision` | `ollama` | internal | `clearaid-models` |
| `tunnel` | `tunnel` | edge | none |

`scripts/prod-local.mjs` sets up a production-like stack on one machine: it writes fixed random secrets, reuses a host Ollama if one is running, opens a Cloudflare quick tunnel and fills in `PUBLIC_URL`, `PLAID_REDIRECT_URI` and `PLAID_WEBHOOK_URL`.

### 7.3 Render (`render.yaml`)

- `clearaid-api`: Docker web service with a persistent disk for the data.
- `clearaid-web`: the Next.js web service.
- `clearaid-ai`: a private service (`ai/Dockerfile`, `ai/start.sh`) running Ollama plus the rag/OCR service on an 8 GB instance (llama3.2:3b) with a model disk. The API suspends it after `AI_IDLE_MINUTES` without use and resumes it on the next AI request (`lib/ai-power.ts`, using the Render API).

## 8. Operating modes

| Mode | Trigger | Behaviour |
|---|---|---|
| Demo / simulated PayPal | No `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` | Orders, captures, payouts and refunds are simulated (`SIM-` IDs) and labelled in the UI |
| Live PayPal (sandbox or live) | Keys set, `PAYPAL_ENV` | Real PayPal REST calls and webhooks |
| Partner onboarding | `PAYPAL_PARTNER_*` set | "Connect with PayPal": NGOs grant permissions by logging in. Payments go to that merchant and refunds are made on its behalf |
| Simulated bank feed | No Plaid keys | "Connect bank" adds a simulated feed |
| Live Plaid | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | Plaid Link, `/transactions/sync`, webhooks, re-login handling |
| AI on | Ollama reachable, `LOCAL_AI` not `off` | Local model for every AI feature |
| AI off / unreachable | `LOCAL_AI=off` or Ollama down | Heuristic fallbacks; Copilot falls back to keyword search if only FAISS is down |
| Clean sandbox data | `npm run sandbox:data` | Resets to NGO, logins, funds and payees only, then fills the app from real PayPal and Plaid sandbox transactions |

## 9. Design decisions

| Decision | Rationale | Trade-off |
|---|---|---|
| Hash-chained, append-only ledger and audit log | Tamper evidence that anyone can verify without trusting the server | Corrections are extra entries; history grows |
| Rule-based tracing and anonymisation (no AI) | Deterministic, explainable, testable; money allocation must never be guessed | Free-text names outside known patterns aren't caught |
| Local AI only (Ollama + FAISS) | Beneficiary, donor and bank data never leave the NGO; no per-call cost | Needs about 6 GB RAM; slower without a GPU |
| AI recommends, humans decide | Accountability stays with people; failed rules block auto-approval | Some manual work remains |
| Embeds built from a whitelist | Publishing can't leak fields by accident when the data model grows | New public fields need explicit work |
| Donor allowlist in the gate | New routes are closed to donors by default | Each donor-visible route must be added explicitly |
| JSON file store | Zero setup for the hackathon; atomic writes | Single instance; production needs Postgres |
| Separate API and web services | Clear boundary; the UI proxies `/api/*` so cookies stay same-origin | Two processes to run |
| Simulated modes for every integration | The demo runs anywhere without keys | Simulated data must be clearly labelled (it is) |

## 10. Constraints and known limits

See the [README](../README.md#known-limits) and [BRD §8](BRD.md#8-assumptions-and-constraints). In short: one NGO per deployment, USD only, a single-instance store, username and password only, and rule-based anonymisation limited to known patterns.
