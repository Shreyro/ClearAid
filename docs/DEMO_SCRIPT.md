# ClearAid: demo recording script

A ready-to-record walkthrough of ClearAid. The **full cut** runs about **5 minutes** and the **short cut** about **3 minutes** (see the end). Every click below was checked against the current `main` build with the seeded demo data.

The story: *Coastal Relief Collective* (fictional) runs three relief funds. We follow money in (PayPal, a bank statement), trace it to funds, prove what it was spent on, stop a fraud, publish the figures safely and ask questions of the books, all with a tamper-evident trail.

---

## 1. Before you record (10 minutes, once)

### 1.1 Start everything

Open four terminals in the `ClearAid` folder.

```bash
cd backend && npm install && npm run dev
```

```bash
cd frontend && npm install && npm run dev
```

```bash
pip install -r rag/requirements.txt
```

```bash
python rag/server.py
```

Ollama must be running with these models pulled (once):

```bash
ollama pull llama3.1:8b && ollama pull nomic-embed-text && ollama pull llava
```

Optional, for the embed scene: serve the demo NGO website in a fifth terminal.

```bash
python -m http.server 5500 --directory demo-site
```

Optional: with `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` (sandbox) in `backend/.env`, the donation scene shows the real PayPal window. Without keys it uses a clearly labelled simulated payment, which is fine for the recording.

### 1.2 Reset and prepare

1. Open http://localhost:3000, sign in as **priya / admin-demo**, and click **Reset demo data** (bottom of the sidebar). This restores the scenario exactly.
2. **Warm up the AI** so the first answer on camera is fast: open **Copilot** and ask any question once (for example *"How much is still held in Cyclone Asha?"*). Wait for the answer. The top-right card should **not** say "Copilot is partly offline". Then click **New chat**.
3. **Find the pending payment request.** In the same browser, open http://localhost:3000/api/withdrawals?status=pending_approval and copy the `id` of the **Kalinga Rice & Pulses Traders** request ($3,200; it already has Daniel's signature). Keep http://localhost:3000/spend/<that id> ready in a tab. (There's no menu link to requests waiting for signatures yet; see LLD §8.)
4. Open a **private / incognito window** and sign in as **daniel / user-demo**. You'll switch to it once.
5. Have these two files ready in a folder you can reach quickly:
   - `docs/sample-bank-statement.csv`
   - `docs/postman/sample-manual-receipt.png` (AquaPure invoice INV-4471, $275, `#ASHA`)

### 1.3 Recording settings

- 1920×1080, browser zoom **110%**, bookmarks bar hidden, notifications off.
- Light theme. Close other tabs except: Money flow, the `/spend/<id>` tab, and (optional) http://localhost:5500.
- Move the mouse slowly and pause about 1 second on each thing you point at; viewers read along.
- Record the voiceover separately if you can, then trim to the clicks.

---

## 2. Full cut (about 5 minutes)

| # | Time | Screen | Do | Say (voiceover) |
|---|---|---|---|---|
| 1 | 0:00 | Sign-in page (signed out) | Hover the four demo logins | "After a disaster, relief NGOs raise money fast and spend it fast. Months later, auditors, boards and donors ask: where did every dollar come from, which fund did it go to, who was it paid to, who approved it, and on what evidence? ClearAid answers that, for NGOs running their funds on PayPal." |
| 2 | 0:15 | Click **Priya Raman · Admin** → **Money flow** | Point at the four stat cards, then sweep the Sankey left → middle → right. Toggle **By payee**, then back to **By category** | "This is Priya, the finance lead. Money in, money out, what's still held, and five bank lines nobody has traced to a fund yet. The diagram follows every dollar from where it came from, through the fund it belongs to, to where it went. PayPal gifts, two bank accounts, three funds." |
| 3 | 0:40 | **Funds → Cyclone Asha** | Scroll to **Collect money for this fund**, click **Open** (donation page opens in a new tab) | "Each fund has its own donation link, its own tracking code (#RO1) and its own ledger." |
| 4 | 0:50 | `/give/cyclone-asha` | Pick **$25**, type a name, click **Donate $25** (PayPal popup with sandbox keys, or the simulated button). Show the thank-you message | "A donor gives through PayPal. The gift is captured and written straight to the fund's ledger under its tracking code." |
| 5 | 1:05 | Back to the app tab → **Transactions** | The new $25 donation is at the top. Point at **From / To / Via** | "And here it is: who it came from, which fund, which PayPal account. Every movement in every fund is in this one list, with filters and CSV export." |
| 6 | 1:15 | **Sources** | On **Main current account ••4821**, click **Upload statement** and choose `sample-bank-statement.csv` | "Most money doesn't arrive through PayPal: grants, bank transfers, cheques. Priya uploads this month's bank statement." |
| 7 | 1:25 | Upload preview | Point at the auto-detected columns, then at the **Anonymised** rows (`Person-…`, `[ACCOUNT ••9301]`, email and phone removed) | "Columns are detected automatically. Before anything is stored, personal details are anonymised: private individuals become stable aliases, and account numbers, phones and emails are removed. Fixed rules, no AI, and the raw text never goes anywhere." |
| 8 | 1:40 | Click **Import 10 rows** | Point at the result counts | "Every line carrying a fund's tracking code, like #RO1 or #ASHA-FOOD, is traced to that fund and its budget category automatically." |
| 9 | 1:50 | **Untagged** | Point at the reasons: *No tracking code*, *Unknown code #RO9*, *Codes for more than one fund* | "The rest wait here, with the reason. Nothing is ever guessed by AI." |
| 10 | 2:00 | Click **Tag** on **Lions Club Cuttack flood appeal #RO2 #RO1** ($1,500) | Choose **Monsoon** $750, click **Split across another fund**, choose **Cyclone Asha** $750. Reason: *Lions Club split the appeal evenly*. Click **Tag $1,500** | "This $1,500 grant names two funds, so Priya splits it, with a reason. Because it's over a thousand dollars, a second person has to sign off before it reaches any ledger." |
| 11 | 2:20 | Incognito window (Daniel) → **Untagged → Waiting for approval** | Click **Review** on the Lions Club line, then **Approve** | "Daniel, the field director, approves it. Priya couldn't approve her own change: that's segregation of duties, built in." |
| 12 | 2:30 | Back to Priya → **Transactions → Record payment** | Click **Read the receipt**, drop `sample-manual-receipt.png`. Wait for the fields to fill | "Now money out. Staff photograph an invoice and the local AI reads it, on this machine: supplier AquaPure, invoice INV-4471, the date, $275, the line items, and the #ASHA code printed on it." |
| 13 | 2:45 | Pre-filled form | Point at the fields (fund **Cyclone Asha** from the #ASHA code); leave **Paid by: Bank transfer**; click **Add to ledger** | "A person checks and confirms. Anything they change is noted in the audit log. When the bank line for this transfer arrives, it's matched to this payment instead of being counted twice." |
| 14 | 3:00 | **Transactions**, direction **Out** | On an older vendor payout (e.g. MedLine Pharma Distributors), click **Evidence →** | "Bigger payments go through a payment request with receipts and delivery photos." |
| 15 | 3:05 | `/spend/…` audit page | Point at **Risk score**, **Rule checks (deterministic)**, **AI findings**, **Receipt, as read by the AI**, **Evidence** | "Fixed rules check the payee is verified, the balance, limits, category caps, unit prices, duplicate receipts, reused photos, photo timestamps and GPS. The local vision model reads the receipt and looks at the photos. The AI recommends; people decide." |
| 16 | 3:20 | **Transactions**, tick **Incl. notices**, search *ShelterKit*; open the **Request rejected** row's evidence (or the rejected ShelterKit request) | Point at the 97% photo match and the 1.6× unit price | "This one was caught: the delivery photo is a 97% match to an earlier delivery, and the price is 1.6 times the expected cost. Rejected, and the rejection is on the ledger for good." |
| 17 | 3:35 | The prepared `/spend/<Kalinga id>` tab | Point at **Signatures: 1 of 2** and the redacted text (`[NAME]`, `[PHONE]`). Click **Approve** | "This $3,200 request needs two different approvers, and Daniel has already signed. The vendor's text had a name and phone number; they're redacted for anyone outside the team. Priya co-signs, and that releases the PayPal payout to the verified vendor." |
| 18 | 3:50 | **Funds → Cyclone Asha → Ledger** | Click **Verify hash chain** | "Every movement is on a hash chain. Your own browser recomputes every SHA-256, so nobody, not even us, can quietly edit history." |
| 19 | 4:00 | **Audit log** | Point at today's entries (split requested, approved by Daniel, payment recorded, payout). Click **Verify chain** | "And every action, every sign-in, tag, approval and export, is on a second hash chain: who did what, when, and why." |
| 20 | 4:10 | **Settings → Public embeds → New embed** | Keep **Cyclone Asha**. Tick **Money flow diagram**; set **Who was paid** to *Name registered payees only*. Point at the live preview. Click **Publish** | "Nothing is public by default. Priya chooses, block by block, what the NGO's website may show, sees exactly what the public will get, and publishes. Donor names, staff, bank references and the audit log can never appear here." |
| 21 | 4:25 | Click **Get code** → **Copy code**, then open the embed link (or paste the code into a `demo-site` page at http://localhost:5500) | Show the embed live on the website | "It's one iframe on the NGO's own site, kept up to date from the ledger, and it can be paused in one click." |
| 22 | 4:35 | **Copilot** | Click **Where did the Cyclone Asha money come from and where did it go?** Point at the answer and its sources | "Finally, the Copilot. Llama 3.1 runs locally over a FAISS index of every record, so no donor or bank data leaves the machine. It answers with exact totals and links to the records." |
| 23 | 4:50 | Sign out → sign in as **maya / donor-demo** → **Copilot** | Ask: *Where did the Monsoon preparedness money go?* | "Maya is a major donor with a read-only login to the fund she supports. She asks about a fund she can't see, and access is enforced before any search, not left to the model." |
| 24 | 5:00 | **Money flow** (as Maya) | Hold on the screen | "Receipts read on-device, rule checks and AI audit, two-person sign-off, PayPal payouts to verified payees, tamper-evident books, and publishing only what you choose. ClearAid: every relief dollar, accounted for." |

---

## 3. Short cut (about 3 minutes)

Use scenes **1, 2, 6–8, 10–11, 12–13, 16, 18, 20, 22, 24** and compress the lines:

| Time | Scene | Say |
|---|---|---|
| 0:00 | Sign-in → Money flow | "Relief NGOs move money fast, then can't prove where it went. ClearAid traces every dollar from source, to fund, to payee." |
| 0:20 | Upload statement + preview | "Bank statements come in anonymised: no names, accounts or phones are stored." |
| 0:40 | Import → Untagged | "Lines with a fund's tracking code are traced automatically; the rest wait here with a reason. No AI guessing." |
| 0:55 | Split Lions Club → Daniel approves | "Large manual tags need a second person. Built-in segregation of duties." |
| 1:20 | Record payment from receipt | "Receipts are read by a local AI model: supplier, invoice, total, line items, tracking code. A person confirms." |
| 1:45 | Rejected ShelterKit evidence | "Rule checks and a vision model caught a reused photo and an inflated price." |
| 2:05 | Verify hash chain | "Every entry is on a hash chain your browser verifies." |
| 2:20 | Public embed preview → Publish | "Publish exactly what you choose, nothing else." |
| 2:35 | Copilot answer | "Ask the books in plain language, privately, on your own machine." |
| 2:50 | Close | "ClearAid: every relief dollar, accounted for." |

---

## 4. If something goes wrong on camera

| Problem | Quick fix |
|---|---|
| Copilot shows **partly offline** | Ollama or `rag/server.py` isn't running. Start them, wait about 30 s, and ask again. Keyword search still answers if only FAISS is down |
| Receipt isn't read (form stays empty) | OCR/AI is still loading; wait and retry, or click **Enter by hand** and type: AquaPure Water Systems, INV-4471, 2026-11-02, $275, Cyclone Asha |
| "This file was already imported" | The statement was uploaded in an earlier take. Click **Reset demo data** and repeat the preparation steps |
| The Kalinga request is already paid | It was approved in an earlier take. **Reset demo data**, then look up the new `id` (IDs change on every reset) |
| The demo-site page says "no longer published" | Its built-in embed keys were removed by the reset. Paste the code of the embed you just created over the `<iframe>` in `demo-site/asha.html` |
| PayPal popup is blocked | Allow pop-ups for localhost, or record without PayPal keys (simulated payment) |

---

## 5. Submission write-up (draft)

**Inspiration.** Disaster giving spikes, then collapses on distrust. Small relief NGOs can't afford finance teams, and their books are scattered across PayPal exports, bank statements and photos of receipts.

**What it does.** ClearAid is a financial-controls tool for relief NGOs on PayPal. It pulls money in from PayPal and bank accounts (CSV or Plaid), anonymises bank data before storing it, and traces every line to a fund by tracking code. It reads receipts with a local AI model, audits payment requests with deterministic rules plus a local vision model, and requires two-person sign-off for large payouts and reallocations. Every movement goes on a per-fund hash chain and every action on an audit-log hash chain, both verifiable in the browser. Admins publish exactly the figures they choose as an embed, and a local Copilot answers questions about the books without data leaving the machine.

**How we built it.** Next.js 16 + React 19 front end; Hono API on Node 22 (TypeScript, Zod); a JSON store with atomic writes.
- **PayPal:** JS SDK buttons, Orders v2 (create/capture), Payouts, capture refunds, verified webhooks, Transaction Search, Partner Referrals for connecting NGO accounts by login.
- **Plaid:** Link, `/transactions/sync`, signed webhooks, update mode.
- **Local AI:** Ollama (Llama 3.1 8B; llava for photos) with JSON-schema-constrained outputs; EasyOCR + PyMuPDF for receipts; FAISS + nomic-embed-text for retrieval.
- **Integrity:** SHA-256 hash chains re-verified in the browser with WebCrypto; integer-cent money with largest-remainder pro-rata splits.

**Challenges.** Keeping AI out of anything that allocates money (tracing and anonymisation are rule-based), making publishing safe by construction (whitelisted embed payloads tested against the whole demo data set), and exact money maths across splits, refunds and fund closure.

**What's next.** PayPal Multiparty with delayed disbursement per NGO, SSO and MFA, Postgres with externally anchored chain heads, a vendor portal for payment requests, and AI suggestions for what to publish.
