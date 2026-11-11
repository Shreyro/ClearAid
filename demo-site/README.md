# Demo NGO website (ClearAid embeds)

A small static website for the fictional **Coastal Relief Collective**, showing how an NGO puts ClearAid's public embeds on its own site. It is plain HTML and CSS with no build step, served from a different address (port 5500) than ClearAid (port 3000), the same as a real third-party website.

| Page | Embed | Colours |
|---|---|---|
| `index.html` | All funds combined, with a line per fund, the money-flow diagram and the over-time chart | Dark, on a dark band of the page |
| `asha.html` | One fund (Cyclone Asha): totals, channels, categories, registered payees, latest movements | Light |
| `floods.html` | Two funds combined (Mahanadi + Monsoon), with a line per fund | Match the visitor's device (the page does too) |

Each embed is exactly the code ClearAid gives under **Settings → Public embeds → Get code**: an `<iframe>` plus the optional `embed.js` that sizes the frame to fit. Nothing else from ClearAid is used.

## Run it

1. Start ClearAid (backend on 4000, frontend on 3000; see the main README).
2. Serve this folder:

   ```bash
   python -m http.server 5500 --directory demo-site
   ```

3. Open http://localhost:5500.

## Using your own embeds

The three embeds were published from the demo admin login (`priya`) and are listed in ClearAid under Settings → Public embeds as "Demo site: …". If you reset the demo data, they're deleted, and the pages show "These figures are no longer published". To fix that, create new embeds and paste their code over the `<iframe>` lines (or replace the key after `/embed/`).

Change something in ClearAid (record a payment, tag a bank line, switch an embed's colours or funds) and the pages update by themselves within a minute, with no change to this site.

For a real deployment, replace `http://localhost:3000` with ClearAid's public address.
