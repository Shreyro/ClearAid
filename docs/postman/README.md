# ClearAid API tests (Postman)

- `ClearAid.postman_collection.json`: 385 requests in 13 folders covering every backend route, with 1,567 assertions (status codes, access rules, hash-chain re-computation, anonymisation, maker-checker, recorded payments, PayPal accounts, public embeds, leftover returns to donors).
- `report.html`: the result of the last run (all passed). Open it in a browser.
- `sample-receipt.png`, `sample-invoice.png`, `sample-manual-receipt.png`, `sample-invoice.pdf`, `sample-late-invoice.png`: the files the upload requests attach.

Also covered:

- **Leftover back to donors** (folder 12): switching it on and off per fund, the donation page offering it, two gifts from one donor counted as one, nothing owed while the fund is open, the share worked out from the snapshot taken at closing (leftover × what they gave ÷ everything raised), refund vs one payout, owed money that can't be moved to another fund, sending, the history, the ledger entry, the audit log, turning it off keeping earlier requests, and staff being refused.
- **Donate form in embeds** (folder 10): only open funds are listed, with nothing beyond what the donation link already shows.
- **Manual entry** (folders 04 and 11): a fund filled in by hand (blank need rows left out), a payment recorded by hand with or without its receipt, a receipt stored without AI reading, and a receipt attached later.
- **Local AI only** (folder 01): the config reports local AI and no cloud AI provider or outbound webhook.
- **PayPal money reaching the bank** (folders 06 and 07): marking a deposit as a transfer from a PayPal account, tagging it refused (it would count twice), the Transfers tab, undoing it, linking a bank account to a PayPal account, the reconciliation on each PayPal account, and staff refused.
- **Copilot chat history** (folders 01 and 08): signed-out requests refused, an empty history, a failed question not saved as a chat, unknown chat ids and empty questions refused, delete and rename validation, and a donor login reaching only its own (empty) history.
- **Bank syncing** (folder 06): sync every connected bank at once, each bank login's health and the sync settings, reconnecting refused without Plaid keys, and unsigned or forged Plaid webhooks refused.

Run it against a backend with fresh demo data, no PayPal or Plaid keys, and no local model or OCR running. The run creates test funds and logins, and resets the demo data in its last folder.

```bash
cd backend && DATA_DIR=/tmp/clearaid-postman PORT=4100 OLLAMA_URL=http://127.0.0.1:9 RAG_URL=http://127.0.0.1:9 npx tsx src/server.ts
```

```bash
cd docs/postman && npx newman run ClearAid.postman_collection.json --env-var baseUrl=http://localhost:4100 --working-dir .
```

In the Postman app, import the collection, set the `baseUrl` collection variable, and point Postman's working directory at this folder so the upload requests find the sample files.

Not covered: the signed-in event stream (`/api/stream` never ends), the live PayPal, Plaid, local AI and OCR paths (they need keys, Ollama or the rag service), PayPal's payout webhooks for returns and Plaid's signed webhooks (they need the provider's signature; covered by the backend's unit tests).
