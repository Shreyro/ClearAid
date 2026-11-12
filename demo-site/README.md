# Demo NGO website (ClearAid embeds)

A small static website for the fictional **Coastal Relief Collective**, showing how an NGO puts ClearAid's public embeds on its own site. It is plain HTML and CSS with no build step, served from a different address (port 5500) than ClearAid (port 3000), the same as a real third-party website.

`index.html` shows three embeds:

| Embed (key) | Shows | Colours |
|---|---|---|
| `demo-cyclone-asha` | One fund (Cyclone Asha): totals, channels, categories, registered payees, latest movements | Light |
| `demo-floods` | Two funds combined (Mahanadi and Monsoon), with a line per fund | Match the visitor's device |
| `demo-all-funds` | Every fund, with a line per fund, the money-flow diagram and the over-time chart | Dark |

## Run it

1. Start ClearAid (backend on 4000, frontend on 3000; see the main README).
2. Serve this folder:

   ```bash
   python -m http.server 5500 --directory demo-site
   ```

3. Open http://localhost:5500.

## How it finds ClearAid

`clearaid.js` decides where ClearAid is: on `localhost` it uses your local ClearAid (port 3000). If you ever serve this folder from another address, it falls back to the `HOSTED` address at the top of that file; change it to point at your own ClearAid.

## The embeds

The three embeds use fixed demo keys (`demo-all-funds`, `demo-cyclone-asha`, `demo-floods`). ClearAid creates them by itself when it starts, in a fresh local copy, so nothing has to be pasted and a data reset brings them back. To stop that, set `DEMO_EMBEDS=off` on the backend.

A real NGO website instead pastes the code ClearAid gives under **Settings, Public embeds, Get code**: an `<iframe>` plus the optional `embed.js`. Nothing else from ClearAid is used.

Change something in ClearAid (record a payment, tag a bank line, switch an embed's colours or funds) and the page updates by itself within a minute, with no change to this site.

## Where to test it

Test the demo site **locally** (see [Run it](#run-it)). It is not deployed on Render.
