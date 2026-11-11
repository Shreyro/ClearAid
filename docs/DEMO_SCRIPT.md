# ClearAid: 3-minute demo script

Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (sandbox) first and run Ollama with `llama3.1:8b` and `llava` pulled, so judges see the real PayPal popup and live local AI audits. Click **Reset demo data** in the persona menu before recording.

| Time | Screen | What to show and say |
|---|---|---|
| 0:00 | Home | "After a disaster, donors give, then wonder where it went. ClearAid makes transparency a property of the payment itself." Point at the stats: paid to verified vendors, requests stopped by audit. |
| 0:15 | Fund page | Scroll: money in vs out, spend vs policy caps, needs progress, **Crisis insights** written by the local AI model from the ledger. |
| 0:35 | Donate box | Donate $25 with **PayPal JS SDK v6**. The live activity feed updates instantly over server-sent events. Click **Follow my dollar**. |
| 0:55 | My impact (Maya) | "Every payout is charged pro-rata to the money in the fund at that moment." Show "~1.8 rations, ~21 jerrycans". On the closing fund, choose **refund** vs **carry forward**. |
| 1:15 | Vendor portal (CleanHands) | Pick the hygiene-kit need (amount auto-fills from the expected unit cost). Type a purpose containing a name, phone number and ID number. Generate a sample receipt and add the **synthetic test photo**. Submit. |
| 1:35 | Request detail | The local model's audit: receipt line items extracted, the synthetic photo flagged, PII redacted ([NAME], [PHONE], [GOV_ID]) while the NGO still sees the original. |
| 1:55 | Fraud case | Open the rejected ShelterKit request: reused photo (97% perceptual match), 1.6× unit price, rejection logged publicly. |
| 2:10 | NGO console (as Priya) | The $3,200 Kalinga request already has Daniel's signature. Priya co-signs (dual approval), which releases a **PayPal Payout**; the ledger and needs bars update live. Daniel can't sign twice. |
| 2:30 | Copilot | "Reconcile the last 31 days of donations against PayPal", then "Refund $20 of the most recent donation". The **PayPal Agent Toolkit** refund pauses for confirmation and lands on the public ledger. |
| 2:45 | Ledger tab | **Verify hash chain**: the browser recomputes every SHA-256 itself. Then Funds tab, **Finalise** Mahanadi: refunds via PayPal and carry-forwards, balance to $0.00. |
| 3:00 | Close | "Receipts, photos, AI audit, human approval, PayPal payout, public ledger. Every relief dollar, accounted for." |

## Devpost write-up (draft)

**Inspiration.** Disaster giving spikes and then collapses on distrust. Donors rarely learn what their money bought, and NGOs drown in reporting.

**What it does.** Dedicated relief funds on PayPal where money can only leave as an audited, approved payout to a verified vendor. Every movement is published on a hash-chained public ledger with AI-redacted memos. Donors follow their exact share of each delivery and choose refund or carry-forward for leftovers.

**How we built it.** Next.js 16 + TypeScript.
- **PayPal:** JS SDK v6, Orders v2 (DONATION items), Payouts, partial capture refunds, verified webhooks, Transaction Search.
- **Local AI (Ollama):** one model (Llama 3.1 8B) for redaction, audits, insights, fund drafting and the Copilot, with a local vision model only for reading images. Schema-constrained JSON outputs; nothing leaves the machine.
- **Supporting pieces:** AG Grid for the ledger; perceptual hashing and EXIF analysis in the browser; SSE for live updates; Render blueprint.

**Challenges.**
- Making money math exact: integer cents and largest-remainder pro-rata splits, so refunds and carry-forwards drain a closed fund to exactly $0.00.
- Keeping AI actions safe: gated tools, refunds capped at the donor's unspent share, server-side conversation state.

**What's next.** PayPal Multiparty with delayed disbursement per NGO, Log in with PayPal for donors, recurring giving via Subscriptions, ledger anchoring, and a public API for journalists and auditors.
