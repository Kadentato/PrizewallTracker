"""Pull confirmed sales from 130point.com's sales backend for the Riftbound Plated Legends.

Usage:
  python scrape130.py                 -> queries every card in prizewall.json, writes 130point-raw.json
  python scrape130.py "riftbound ahri prizewall psa 10"   -> prints matching rows for one query

The public 130point.com front end sits behind a Cloudflare challenge, but the backend it
posts to (back.130point.com/sales/) answers a plain POST with `query=`. Each row carries the
marketplace, title, sale price, accepted Best-Offer price, bid count, sale type, currency,
GMT timestamp and the eBay item id, which is everything a confirmed-sale record needs.
"""
import json, re, sys, time, html, os, urllib.request, urllib.parse
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ENDPOINT = "https://back.130point.com/sales/"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

METAL = re.compile(r"metal|plated|prize\s*wall|prizewall|official event prize", re.I)
PSA10 = re.compile(r"psa\s*(gem\s*(mt|mint)\s*)?10\b", re.I)
EXCLUDE = re.compile(r"release event|prize pack|event promo|release promo|ogn-release|release prize|OGNX|nexus night|best[- ]of|1st place|1 of 1|signature|overnumber|worlds", re.I)

def fetch(query, extra=None):
    data = {"query": query}
    if extra: data.update(extra)
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(ENDPOINT, data=body, headers={"User-Agent": UA, "Referer": "https://130point.com/sales/"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode("utf-8", "ignore")

ROW = re.compile(r"<tr id=\"dRow\"[^>]*data-price=\"([^\"]*)\"[^>]*data-currency=\"([^\"]*)\">(.*?)</tr>", re.S)

def parse(h):
    out = []
    for price, cur, body in ROW.findall(h):
        m = re.search(r"<a href='([^']*)'[^>]*>(.*?)</a>", body, re.S)
        title = html.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip() if m else ""
        href = m.group(1) if m else ""
        ebay = re.search(r"EBAY-v1\|(\d+)\|", href)
        via = "ebay" if "ebay" in href else (re.sub(r"<[^>]+>", "", (re.search(r"Sold Via:.*?</div></div>", body, re.S) or [""])[0]) or "other")
        via_txt = html.unescape(re.sub(r"<[^>]+>", "", (re.search(r"id='soldVia'>(.*?)<span id='titleText'", body, re.S) or ["", ""])[1] if re.search(r"id='soldVia'>(.*?)<span id='titleText'", body, re.S) else "")).replace("Sold Via:", "").replace("\xa0", "").strip()
        props = re.search(r"class=\"props-data\">(.*?)</span>", body, re.S)
        props = html.unescape(props.group(1)) if props else ""
        g = lambda k: (re.search(k + r": ([^-]+?)(?: - |$)", props) or [None, None])[1]
        bo = g("Best Offer Price"); bids = g("Bids"); stype = g("Sale Type")
        d = re.search(r"<b>Date:</b> ([^<]+)", body)
        date = None
        if d:
            try: date = datetime.strptime(d.group(1).strip(), "%a %d %b %Y %H:%M:%S %Z").strftime("%Y-%m-%d")
            except Exception: date = d.group(1).strip()
        try: p = float(price)
        except Exception: p = None
        try: bo = float(bo) if bo else 0
        except Exception: bo = 0
        out.append({"title": title, "price": p, "bestOffer": bo, "currency": cur, "bids": int(bids) if bids and bids.isdigit() else None,
                    "saleType": (stype or "").strip(), "date": date, "ebayId": ebay.group(1) if ebay else None,
                    "url": ("https://www.ebay.com/itm/" + ebay.group(1)) if ebay else href, "via": via_txt.replace(" ", "") or via})
    return out

def is_target(r):
    t = r["title"]
    return bool(PSA10.search(t) and METAL.search(t) and not EXCLUDE.search(t))

def main():
    if len(sys.argv) > 1:
        rows = parse(fetch(" ".join(sys.argv[1:])))
        for r in rows:
            print(("*" if is_target(r) else " "), r["date"], r["currency"], r["price"], "BO" if r["bestOffer"] else "  ", r["saleType"], r["bids"], r["via"], "|", r["title"][:90])
        print(len(rows), "rows")
        return
    cards = json.load(open(os.path.join(HERE, "prizewall.json"), encoding="utf-8"))["cards"]
    raw = {}
    for c in cards:
        champ = c["champion"].replace("'", "")
        # One query per card in Caden's phrasing. 130point allows only a few dozen queries an hour (429 + Retry-After).
        variants = [f"PSA 10 {c['champion']} Prizewall"]
        seen = {}
        for q in variants:
            try:
                rows = parse(fetch(q))
            except Exception as e:
                print("ERR", q, e); rows = []
            for r in rows:
                key = r["ebayId"] or (r["title"] + r["date"] + str(r["price"]))
                seen.setdefault(key, r)
            time.sleep(3)
        raw[c["id"]] = list(seen.values())
        hits = [r for r in raw[c["id"]] if is_target(r)]
        print(f"{c['id']:18s} rows={len(raw[c['id']]):3d} target={len(hits)}")
    json.dump(raw, open(os.path.join(HERE, "130point-raw.json"), "w", encoding="utf-8"), indent=1)

if __name__ == "__main__":
    main()
