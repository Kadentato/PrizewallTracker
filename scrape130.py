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
    headers = {
        "User-Agent": UA,
        "Referer": "https://130point.com/sales/",
        "Origin": "https://130point.com",
        "Accept": "text/html, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
    }
    req = urllib.request.Request(ENDPOINT, data=body, headers=headers)
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

# ---- sync mode: same rules as the app's mergeRows(), so the Action and the browser agree ----
SYNC_TTL = 24 * 3600
QUERY_GAP = 3.0

def row_matches_card(r, card):
    if not is_target(r): return False
    if r["currency"] != "USD" or not r["price"] or not r["date"]: return False
    t = r["title"]
    champ = card["champion"].replace("'", "").lower()
    plain = t.replace("'", "").lower()
    dis = card.get("disambig")
    if champ not in plain and not (dis and re.search(dis, t, re.I)): return False
    if dis and not re.search(dis, t, re.I): return False
    return True

def item_id_of(s):
    m = re.search(r"/itm/(\d+)", s.get("url") or "")
    return m.group(1) if m else None

def days(iso):
    return datetime.strptime(iso[:10], "%Y-%m-%d").timestamp() / 86400

def merge_rows(card, rows):
    existing = card.get("sales") or []
    ids = {i for i in (item_id_of(s) for s in existing) if i}
    added = []
    for r in rows:
        if not row_matches_card(r, card): continue
        if r["ebayId"] and r["ebayId"] in ids: continue
        price = r["bestOffer"] if r["bestOffer"] > 0 else r["price"]
        if any(abs(s["price"] - price) < 0.5 and abs(days(s["date"]) - days(r["date"])) <= 1.5 for s in existing + added): continue
        sale = {"date": r["date"], "price": price, "source": "ebay" if r["via"] == "ebay" else r["via"], "via": "130point",
                "url": r["url"], "title": r["title"],
                "type": "offer" if r["bestOffer"] > 0 else ("auction" if "auction" in r["saleType"] else "bin")}
        if r["bids"]: sale["bids"] = r["bids"]
        if r["bestOffer"] > 0: sale["listed"] = r["price"]
        added.append(sale)
        if r["ebayId"]: ids.add(r["ebayId"])
    return added

class RateLimited(Exception):
    def __init__(self, secs): super().__init__("rate limited"); self.secs = secs

def fetch_or_limit(q):
    try:
        return fetch(q)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            try: secs = int(e.headers.get("Retry-After") or 3600)
            except Exception: secs = 3600
            raise RateLimited(secs)
        raise

def sync(path):
    data = json.load(open(path, encoding="utf-8"))
    cards = data["cards"]
    now = time.time()
    order = sorted(cards, key=lambda c: c.get("synced130") or 0)
    added_total, done, limited = 0, 0, None
    for c in order:
        if now - (c.get("synced130") or 0) / 1000 < SYNC_TTL:
            continue
        q = "PSA 10 %s Prizewall" % c["champion"]
        try:
            rows = parse(fetch_or_limit(q))
        except RateLimited as e:
            limited = e.secs
            print("130point rate limit hit; retry after %ds. Stopping this run." % e.secs)
            break
        except Exception as e:
            print("ERR", c["id"], e); time.sleep(QUERY_GAP); continue
        seen, uniq = set(), []
        for r in rows:
            k = r["ebayId"] or (r["title"] + str(r["date"]) + str(r["price"]))
            if k in seen: continue
            seen.add(k); uniq.append(r)
        fresh = merge_rows(c, uniq)
        if fresh:
            c["sales"] = sorted((c.get("sales") or []) + fresh, key=lambda s: s["date"])
            added_total += len(fresh)
        c["synced130"] = int(time.time() * 1000)
        done += 1
        print("%-18s rows=%2d new=%d" % (c["id"], len(uniq), len(fresh)))
        time.sleep(QUERY_GAP)
    if done or added_total:
        stamp = int(time.time() * 1000)
        data["updatedAt"] = stamp
        if added_total: data["asOf"] = datetime.utcnow().strftime("%Y-%m-%d")
        if all(time.time() - (c.get("synced130") or 0) / 1000 < SYNC_TTL for c in cards): data["syncedAt"] = stamp
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1, ensure_ascii=False); f.write("\n")
    print("cards checked: %d, new sales: %d%s" % (done, added_total, ", rate-limited" if limited else ""))
    # GitHub Actions reads these to decide whether to commit
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a") as f:
            f.write("added=%d\nchecked=%d\n" % (added_total, done))

def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--sync":
        sync(sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "prizewall.json"))
        return
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
