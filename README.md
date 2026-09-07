# Prizewall

What is a metal card actually worth — not what someone lists it for, but what the last person paid? Prizewall tracks every Riftbound **Plated Legend** (the metal Prize Wall promos from Regional Qualifiers) in **PSA 10**, using confirmed sales only, in USD, and ranks them with a small opportunity score.

- 40 cards: 12 Origins, 4 Proving Grounds, 12 Spiritforged, 12 Unleashed
- Confirmed sales pulled from 130point (eBay completed listings, including accepted Best Offers), plus PriceCharting and individual eBay listing pages for the initial seed
- PSA 10 population per card, live asks shown separately as context — never counted as sales
- A "Rift Score" that blends scarcity, momentum, liquidity, entry gap and gem premium, discounted by how much real data exists

## Run it

No build step. The page loads React from a CDN and compiles `app.jsx` in the browser.

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open <http://localhost:8798/>. `start-server.vbs` does the same without a console window.

The server is tiny on purpose: it serves the folder and exposes two routes the page uses —
`GET /api/130point?q=…` proxies a sales search to 130point (with a cache and respect for its rate limit) and `POST /api/save` writes the merged data back to `prizewall.json`.

## How data gets in

Open the site and it syncs by itself: any card not checked in the last day is queried as `PSA 10 [Champion] Prizewall`, new sales are merged (deduped by eBay item id, then by price and date) and saved. 130point allows only a few dozen queries an hour, so the first full pass takes a few windows; the page pauses and resumes on its own. "Sync 130point" in the header forces a pass.

`scrape130.py` is the same search as a standalone script, for when you want rows in a terminal:

```bash
python scrape130.py "PSA 10 Teemo Prizewall"
```

## Files

| File | What it is |
|---|---|
| `index.html` | shell that loads React and `app.jsx` |
| `app.jsx` | the app: board, card detail, charts, sync, Rift Score |
| `prizewall.json` | the data — cards, confirmed sales, raw-metal sales, live asks, populations |
| `serve.ps1` | static server + the two API routes |
| `scrape130.py` | standalone 130point query |
