# ClearAid API tests (Postman)

- `ClearAid.postman_collection.json`: 249 requests in 12 folders covering every backend route, with 990 assertions (status codes, access rules, hash-chain re-computation, anonymisation, maker-checker, recorded payments, PayPal accounts, public embeds).
- `report.html`: the result of the last run (all passed). Open it in a browser.
- `sample-receipt.png`, `sample-invoice.png`: the files the upload requests attach.

Run it against a backend with fresh demo data, no PayPal or Plaid keys, and no local model running. The run creates a test fund and logins, and resets the demo data in its last folder.

```bash
cd backend && DATA_DIR=/tmp/clearaid-postman PORT=4100 npx tsx src/server.ts
```

```bash
cd docs/postman && npx newman run ClearAid.postman_collection.json --env-var baseUrl=http://localhost:4100 --working-dir .
```

In the Postman app, import the collection, set the `baseUrl` collection variable, and point Postman's working directory at this folder so the upload requests find the two sample files.

Not covered: the signed-in event stream (`/api/stream` never ends), and the live PayPal, Plaid and Copilot paths, which need keys or a running local model.
