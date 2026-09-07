/* Prizewall — a tracker for Riftbound Plated Legends (metal Prize Wall promos) in PSA 10.
   Confirmed sales only, USD. Data lives in prizewall.json (refreshed by Claude from chat).
   In-app edits persist to localStorage and are merged by updatedAt, same pattern as comps. */

const { useState, useMemo, useEffect, useRef, useCallback } = React;

const LS_KEY = "prizewall-v1";
const DAY = 86400000;
const SET_ORDER = ["OGN", "OGS", "SFD", "UNL"];
const SET_LABEL = { OGN: "Origins", OGS: "Proving Grounds", SFD: "Spiritforged", UNL: "Unleashed" };

const RANGES = [
  { k: "90", label: "90D", days: 90 },
  { k: "180", label: "6M", days: 180 },
  { k: "all", label: "All", days: null },
];
const SORTS = [
  { k: "score", label: "Rift Score" },
  { k: "value", label: "Last sale" },
  { k: "trend", label: "Trend" },
  { k: "pop", label: "PSA 10 pop" },
  { k: "recent", label: "Recently sold" },
  { k: "set", label: "Set & number" },
  { k: "name", label: "Name" },
];
const WEIGHTS = { scarcity: 0.25, momentum: 0.25, liquidity: 0.15, entry: 0.2, premium: 0.15 };
const TIERS = [
  { k: "prime", label: "Prime", min: 60 },
  { k: "watch", label: "Watch", min: 44 },
  { k: "hold", label: "Hold", min: 34 },
  { k: "pass", label: "Pass", min: -1 },
];

/* ---------------- helpers ---------------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const money = (n) =>
  n == null || isNaN(n) ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyShort = (n) =>
  n == null || isNaN(n) ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2 });
const pct = (n) => (n == null || isNaN(n) ? "—" : (n >= 0 ? "+" : "") + (n * 100).toFixed(0) + "%");
const toDays = (iso) => Date.parse(iso + (iso.length <= 10 ? "T00:00:00" : "")) / DAY;
const todayDays = () => Math.floor(Date.now() / DAY);
const fmtDate = (iso) => new Date(iso.length <= 10 ? iso + "T00:00:00" : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmtDateShort = (iso) => new Date(iso.length <= 10 ? iso + "T00:00:00" : iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const ageLabel = (iso) => {
  const d = Math.round(todayDays() - toDays(iso));
  if (d <= 0) return "today";
  if (d === 1) return "1d ago";
  if (d < 45) return d + "d ago";
  if (d < 365) return Math.round(d / 30) + "mo ago";
  return (d / 365).toFixed(1) + "y ago";
};
const sortByDate = (arr) => [...(arr || [])].sort((a, b) => toDays(a.date) - toDays(b.date));
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/* sorted-ascending sales -> stats over that window */
function seriesStats(sales) {
  if (!sales || !sales.length) return null;
  const prices = sales.map((s) => s.price);
  const xs = sales.map((s) => toDays(s.date));
  const n = prices.length;
  const avg = prices.reduce((a, b) => a + b, 0) / n;
  const min = Math.min(...prices), max = Math.max(...prices);
  const med = median(prices);
  const latest = prices[n - 1];
  const prev = n > 1 ? prices[n - 2] : null;
  const x0 = xs[0];
  const X = xs.map((x) => x - x0);
  const mx = X.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (X[i] - mx) * (prices[i] - avg); den += (X[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  const regFirst = avg + slope * (X[0] - mx);
  const regLast = avg + slope * (X[n - 1] - mx);
  const trendPct = n >= 2 && regFirst ? (regLast - regFirst) / Math.abs(regFirst) : null;
  return { latest, prev, avg, median: med, min, max, slope, trendPct, count: n, first: prices[0], firstDate: sales[0].date, lastDate: sales[n - 1].date };
}
function withinRange(sales, days) {
  if (days == null) return sales;
  const cutoff = todayDays() - days;
  return sales.filter((s) => toDays(s.date) >= cutoff);
}
function movingAvg(sales, win) {
  return sales.map((s, i) => {
    const slice = sales.slice(Math.max(0, i - win + 1), i + 1);
    return slice.reduce((a, b) => a + b.price, 0) / slice.length;
  });
}

/* ---------------- the Rift Score ----------------
   Five parts, each 0–100, blended by weight, then discounted by how much confirmed data exists.
   Every part records whether it was actually measured (na=false) or defaulted to neutral. */
function riftScore(card) {
  const sales = sortByDate(card.sales);
  const st = seriesStats(sales);
  const s120 = withinRange(sales, 120);
  const n90 = withinRange(sales, 90).length;
  const pop10 = card.pop ? card.pop.psa10 : null;
  const bins = (card.asks || []).filter((a) => a.type === "bin");
  const floor = bins.length ? Math.min(...bins.map((a) => a.price)) : null;
  const ref = st ? median(sales.slice(-3).map((s) => s.price)) : null;
  const raw = card.rawMarket ? card.rawMarket.price : null;

  const parts = [];
  let trend = null; // the momentum trend actually used, for the board column
  // 1. scarcity — PSA 10 population, log-scaled. 2 copies ≈ 88, 20 ≈ 47, 150 ≈ 12.
  if (pop10 != null) {
    const v = clamp(100 - (100 * Math.log10(Math.max(pop10, 1))) / Math.log10(300), 0, 100);
    parts.push({ k: "scarcity", label: "Scarcity", v, detail: `${pop10} PSA 10${card.pop.total ? ` of ${card.pop.total} graded` : ""}` });
  } else parts.push({ k: "scarcity", label: "Scarcity", v: 50, na: true, detail: "no PSA population reading yet" });
  // 2. momentum — regression trend of confirmed PSA 10 sales over the last 120 days.
  if (s120.length >= 3) {
    const t = seriesStats(s120).trendPct;
    trend = t;
    parts.push({ k: "momentum", label: "Momentum", v: clamp(50 + t * 50, 0, 100), detail: `${pct(t)} regression trend, ${s120.length} sales / 120d` });
  } else if (sales.length >= 2) {
    const ch = (st.latest - st.prev) / st.prev;
    trend = ch;
    parts.push({ k: "momentum", label: "Momentum", v: clamp(50 + ch * 25, 0, 100), detail: `${pct(ch)} last vs previous sale (half weight, only 2 points)` });
  } else parts.push({ k: "momentum", label: "Momentum", v: 50, na: true, detail: sales.length ? "one sale — no direction yet" : "no confirmed sales yet" });
  // 3. liquidity — how often it actually trades.
  const LQ = [0, 35, 50, 62, 72, 80, 86, 91, 95, 98];
  parts.push({ k: "liquidity", label: "Liquidity", v: n90 >= LQ.length ? 100 : LQ[n90], na: sales.length === 0, detail: `${n90} confirmed sale${n90 === 1 ? "" : "s"} in the last 90 days` });
  // 4. entry — cheapest Buy-It-Now ask vs the median of the last three sales.
  if (floor != null && ref) {
    const r = floor / ref;
    parts.push({ k: "entry", label: "Entry gap", v: clamp(100 - (r - 0.6) * 100, 0, 100), detail: `floor ask ${moneyShort(floor)} is ${r < 1 ? Math.round((1 - r) * 100) + "% under" : Math.round((r - 1) * 100) + "% over"} recent sales (${moneyShort(ref)})` });
  } else parts.push({ k: "entry", label: "Entry gap", v: 50, na: true, detail: floor == null ? "no Buy-It-Now ask live" : `floor ask ${moneyShort(floor)}, but no sale to compare` });
  // 5. gem premium — last PSA 10 sale relative to the raw metal card's market price.
  if (st && raw) {
    const r = st.latest / raw;
    parts.push({ k: "premium", label: "Gem premium", v: clamp(100 - (r - 1) * 20, 0, 100), detail: `PSA 10 trades at ${r.toFixed(1)}× the raw metal market (${moneyShort(raw)})` });
  } else parts.push({ k: "premium", label: "Gem premium", v: 50, na: true, detail: raw ? "no PSA 10 sale to compare" : "no raw market price on file" });

  const blended = parts.reduce((a, p) => a + p.v * WEIGHTS[p.k], 0);
  let conf = sales.length === 0 ? 0.3 : sales.length === 1 ? 0.5 : sales.length === 2 ? 0.65 : sales.length <= 4 ? 0.8 : 1;
  if (pop10 == null) conf = Math.max(0.2, conf - 0.1);
  const score = Math.round(blended * (0.55 + 0.45 * conf));
  const tier = TIERS.find((t) => score >= t.min) || TIERS[TIERS.length - 1];
  return { score, blended: Math.round(blended), conf, tier, parts, floor, ref, st, n90, trend };
}

/* ---------------- 130point sync ----------------
   The local server proxies a sales search to 130point's backend (GET /api/130point?q=…) and
   writes the merged data back (POST /api/save). Rows are filtered to the PSA 10 metal printing,
   USD only, and deduped against what is already on file by eBay item id, then by price+date. */
const SYNC_TTL = 24 * 3600 * 1000;
const RX_METAL = /metal|plated|prize\s*wall|prizewall|official event prize/i;
const RX_PSA10 = /psa\s*(gem\s*(mt|mint)\s*)?10\b/i;
const RX_EXCLUDE = /release event|prize pack|event promo|release promo|ogn-release|release prize|OGNX|nexus night|best[- ]of|1st place|1 of 1|signature|overnumber|worlds/i;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function parse130(htmlText) {
  const doc = new DOMParser().parseFromString(htmlText, "text/html");
  const out = [];
  for (const tr of doc.querySelectorAll("tr#dRow, tr[data-rowid], tr[data-rowId]")) {
    const a = tr.querySelector("#titleText a, a[href*='ebay']");
    const title = a ? a.textContent.trim() : "";
    const href = a ? a.getAttribute("href") || "" : "";
    const idm = href.match(/EBAY-v1\|(\d+)\|/);
    const props = (tr.querySelector(".props-data") || {}).textContent || "";
    const g = (k) => { const m = props.match(new RegExp(k + ": ([^-]+?)(?: - |$)")); return m ? m[1].trim() : null; };
    const bo = parseFloat(g("Best Offer Price") || "0") || 0;
    const bids = parseInt(g("Bids") || "", 10);
    const saleType = (g("Sale Type") || "").toLowerCase();
    const dm = (tr.textContent.match(/Date:\s*\w{3} (\d{1,2}) (\w{3}) (\d{4})/) || []);
    const date = dm.length ? `${dm[3]}-${String(MONTHS[dm[2]] + 1).padStart(2, "0")}-${String(dm[1]).padStart(2, "0")}` : null;
    const via = (tr.querySelector("#soldVia") ? (tr.querySelector("#ebayOuter") ? "ebay" : (tr.querySelector("#soldVia").parentElement.parentElement.textContent || "").replace(/Sold Via:|\s| /g, "").toLowerCase() || "other") : "other");
    out.push({ title, price: parseFloat(tr.getAttribute("data-price")), currency: tr.getAttribute("data-currency") || "USD", bestOffer: bo, bids: isNaN(bids) ? null : bids, saleType, date, ebayId: idm ? idm[1] : null, url: idm ? "https://www.ebay.com/itm/" + idm[1] : href, via });
  }
  return out;
}
const itemIdOf = (s) => { const m = (s.url || "").match(/\/itm\/(\d+)/); return m ? m[1] : null; };
function rowMatchesCard(row, card) {
  const t = row.title;
  if (!RX_PSA10.test(t) || !RX_METAL.test(t) || RX_EXCLUDE.test(t)) return false;
  if (row.currency !== "USD" || !row.price || !row.date) return false;
  const champ = card.champion.replace(/'/g, "").toLowerCase();
  const plain = t.replace(/'/g, "").toLowerCase();
  if (!plain.includes(champ) && !(card.disambig && new RegExp(card.disambig, "i").test(t))) return false;
  if (card.disambig && !new RegExp(card.disambig, "i").test(t)) return false;
  return true;
}
function mergeRows(card, rows) {
  const existing = card.sales || [];
  const ids = new Set(existing.map(itemIdOf).filter(Boolean));
  const added = [];
  for (const r of rows) {
    if (!rowMatchesCard(r, card)) continue;
    if (r.ebayId && ids.has(r.ebayId)) continue;
    const price = r.bestOffer > 0 ? r.bestOffer : r.price;
    const dup = existing.concat(added).some((s) => Math.abs(s.price - price) < 0.5 && Math.abs(toDays(s.date) - toDays(r.date)) <= 1.5);
    if (dup) continue;
    const sale = { date: r.date, price, source: r.via === "ebay" ? "ebay" : r.via, via: "130point", url: r.url, title: r.title,
      type: r.bestOffer > 0 ? "offer" : /auction/.test(r.saleType) ? "auction" : "bin" };
    if (r.bids != null && r.bids > 0) sale.bids = r.bids;
    if (r.bestOffer > 0) sale.listed = r.price;
    added.push(sale);
    if (r.ebayId) ids.add(r.ebayId);
  }
  return added;
}
function queriesFor(card) {
  // Caden's phrasing, one query per card: "PSA 10 [Champion Name] Prizewall"
  return [`PSA 10 ${card.champion} Prizewall`];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUERY_GAP = 3000;          // ms between queries — 130point answers 429 to bursts
let lastQueryAt = 0;
class RateLimited extends Error { constructor(secs) { super("rate limited"); this.retryAfter = secs; } }
async function fetch130(q) {
  const wait = lastQueryAt + QUERY_GAP - Date.now();
  if (wait > 0) await sleep(wait);
  lastQueryAt = Date.now();
  const r = await fetch("api/130point?q=" + encodeURIComponent(q), { cache: "no-store" });
  if (r.ok) return parse130(await r.text());
  if (r.status === 429) {
    let secs = parseInt(r.headers.get("Retry-After") || "", 10);
    if (isNaN(secs)) { try { secs = (await r.json()).retryAfter; } catch {} }
    throw new RateLimited(secs && secs > 0 ? secs : 900);
  }
  throw new Error("proxy " + r.status);
}
const fmtClock = (t) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
async function saveToServer(data) {
  try {
    const r = await fetch("api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data, null, 1) });
    return r.ok;
  } catch { return false; }
}

function loadLocal() { try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; } }
function saveLocal(data) { try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch {} }

function useMeasure() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((es) => { for (const e of es) setW(e.contentRect.width); });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/* ---------------- small UI atoms ---------------- */
function TrendChip({ v, small }) {
  if (v == null) return <span className={"chip chip-flat" + (small ? " chip-sm" : "")}>—</span>;
  const cls = Math.abs(v) < 0.005 ? "flat" : v > 0 ? "up" : "down";
  const arrow = cls === "up" ? "▲" : cls === "down" ? "▼" : "→";
  return <span className={"chip chip-" + cls + (small ? " chip-sm" : "")}>{arrow} {pct(v)}</span>;
}
function ScorePill({ r, small }) {
  return (
    <span className={"score-pill tier-" + r.tier.k + (small ? " sm" : "")} title={`Rift Score ${r.score} · ${r.tier.label}`}>
      <b>{r.score}</b><span>{r.tier.label}</span>
    </span>
  );
}
function SetChip({ s }) { return <span className={"setchip set-" + s}>{s}</span>; }
function Stat({ label, value, sub, tone }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={"stat-value" + (tone ? " tone-" + tone : "")}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/* ---------------- sparkline ---------------- */
function Sparkline({ sales, w = 110, h = 30 }) {
  if (!sales || sales.length < 2) return <div className="spark-empty" style={{ width: w, height: h }} title={sales && sales.length === 1 ? "one confirmed sale" : "no confirmed sales"} />;
  const xs = sales.map((s) => toDays(s.date)), ps = sales.map((s) => s.price);
  const x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1;
  const pmin = Math.min(...ps), pmax = Math.max(...ps);
  const pad = 3;
  const sx = (x) => (x1 === x0 ? w / 2 : pad + ((x - x0) / (x1 - x0)) * (w - 2 * pad));
  const sy = (p) => (pmax === pmin ? h / 2 : h - pad - ((p - pmin) / (pmax - pmin)) * (h - 2 * pad));
  const d = sales.map((s, i) => (i ? "L" : "M") + sx(xs[i]).toFixed(1) + " " + sy(ps[i]).toFixed(1)).join(" ");
  const up = ps[ps.length - 1] >= ps[0];
  const col = up ? "var(--up)" : "var(--down)";
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <path d={d + ` L ${sx(x1).toFixed(1)} ${h - pad} L ${sx(x0).toFixed(1)} ${h - pad} Z`} fill={col} opacity="0.09" />
      <path d={d} fill="none" stroke={col} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={sx(x1)} cy={sy(ps[ps.length - 1])} r="2.3" fill={col} />
    </svg>
  );
}

/* ---------------- big detail chart ---------------- */
function PriceChart({ sales, rawSales, floor, showMA, showRaw }) {
  const [wrapRef, cw] = useMeasure();
  const [hover, setHover] = useState(null);
  const h = 300;
  const W = Math.max(280, cw || 640);
  const padL = 58, padR = 16, padT = 18, padB = 34;
  const plotW = W - padL - padR, plotH = h - padT - padB;

  const model = useMemo(() => {
    const raw = showRaw ? rawSales : [];
    const all = [...sales, ...raw];
    if (!all.length) return null;
    const xs = all.map((s) => toDays(s.date));
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    if (x1 - x0 < 14) { x0 -= 7; x1 += 7; }
    const ps = all.map((s) => s.price).concat(floor != null ? [floor] : []);
    let pmin = Math.min(...ps), pmax = Math.max(...ps);
    if (pmin === pmax) { pmin *= 0.9; pmax *= 1.1; }
    const range = pmax - pmin;
    pmin = Math.max(0, pmin - range * 0.12); pmax += range * 0.12;
    const sx = (x) => padL + ((x - x0) / (x1 - x0)) * plotW;
    const sy = (p) => padT + (1 - (p - pmin) / (pmax - pmin)) * plotH;
    const pts = sales.map((s) => ({ x: sx(toDays(s.date)), y: sy(s.price), s, kind: "psa10" }));
    const rpts = raw.map((s) => ({ x: sx(toDays(s.date)), y: sy(s.price), s, kind: "raw" }));
    const ma = showMA && sales.length >= 3 ? movingAvg(sales, Math.min(5, sales.length)) : null;
    const maPts = ma ? ma.map((v, i) => ({ x: pts[i].x, y: sy(v) })) : null;
    const ticks = [];
    for (let i = 0; i <= 4; i++) ticks.push(pmin + ((pmax - pmin) * i) / 4);
    const xt = [];
    const span = x1 - x0;
    const step = span > 240 ? 60 : span > 100 ? 30 : span > 40 ? 14 : 7;
    for (let d = Math.ceil(x0 / step) * step; d <= x1; d += step) xt.push(d);
    return { sx, sy, pts, rpts, maPts, ticks, xt, x0, x1 };
  }, [sales, rawSales, floor, W, showMA, showRaw]);

  const onMove = useCallback((e) => {
    if (!model) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const my = ((e.clientY - rect.top) / rect.height) * h;
    let best = null, bd = Infinity;
    for (const p of [...model.pts, ...model.rpts]) {
      const d = Math.abs(p.x - mx) + Math.abs(p.y - my) * 0.35;
      if (d < bd) { bd = d; best = p; }
    }
    setHover(best);
  }, [model, W]);

  if (!model) return <div className="chart-empty">No confirmed PSA 10 sale on record yet.</div>;
  const lineD = model.pts.map((p, i) => (i ? "L" : "M") + p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" ");
  const areaD = model.pts.length ? lineD + ` L ${model.pts[model.pts.length - 1].x.toFixed(1)} ${padT + plotH} L ${model.pts[0].x.toFixed(1)} ${padT + plotH} Z` : null;
  const rawD = model.rpts.map((p, i) => (i ? "L" : "M") + p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" ");
  const maD = model.maPts ? model.maPts.map((p, i) => (i ? "L" : "M") + p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" ") : null;
  const up = model.pts.length > 1 ? model.pts[model.pts.length - 1].s.price >= model.pts[0].s.price : true;
  const col = up ? "var(--up)" : "var(--down)";

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg width={W} height={h} viewBox={`0 0 ${W} ${h}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={col} stopOpacity="0.16" />
            <stop offset="100%" stopColor={col} stopOpacity="0" />
          </linearGradient>
        </defs>
        {model.ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={model.sy(t)} y2={model.sy(t)} className="grid" />
            <text x={padL - 8} y={model.sy(t) + 3.5} className="axis-y">{moneyShort(t)}</text>
          </g>
        ))}
        {model.xt.map((d, i) => (
          <text key={i} x={model.sx(d)} y={h - 12} className="axis-x" style={{ textAnchor: "middle" }}>{fmtDateShort(new Date(d * DAY).toISOString().slice(0, 10))}</text>
        ))}
        {floor != null && (
          <g>
            <line x1={padL} x2={W - padR} y1={model.sy(floor)} y2={model.sy(floor)} className="floor" />
            <text x={W - padR} y={model.sy(floor) - 5} className="floor-lbl">floor ask {moneyShort(floor)}</text>
          </g>
        )}
        {showRaw && model.rpts.length > 1 && <path d={rawD} fill="none" stroke="var(--ink-faint)" strokeWidth="1.4" strokeDasharray="3 4" opacity="0.8" />}
        {showRaw && model.rpts.map((p, i) => <circle key={"r" + i} cx={p.x} cy={p.y} r={hover === p ? 4.5 : 2.6} fill="var(--card)" stroke="var(--ink-faint)" strokeWidth="1.3" />)}
        {areaD && model.pts.length > 1 && <path d={areaD} fill="url(#fill)" />}
        {model.pts.length > 1 && <path d={lineD} fill="none" stroke={col} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />}
        {maD && <path d={maD} fill="none" stroke="var(--ink-soft)" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.7" />}
        {model.pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={hover === p ? 5.5 : 3.4} fill={col} stroke="#fff" strokeWidth="1.3" />)}
        {hover && <line x1={hover.x} x2={hover.x} y1={padT} y2={padT + plotH} className="guide" />}
      </svg>
      {hover && (
        <div className="tip" style={{ left: Math.min(Math.max(hover.x, 80), W - 80), top: hover.y - 8 }}>
          <b>{money(hover.s.price)}</b>
          <span>{fmtDate(hover.s.date)} · {hover.kind === "raw" ? "raw metal · " : "PSA 10 · "}{hover.s.source}{hover.s.type === "offer" ? " · best offer" : hover.s.type === "bin" ? " · buy it now" : hover.s.bids ? ` · ${hover.s.bids} bids` : ""}</span>
        </div>
      )}
      <div className="legend">
        <span><i className="lg lg-psa" style={{ background: col }} /> PSA 10 confirmed sales</span>
        {showRaw && <span><i className="lg lg-raw" /> raw metal sales (ungraded, separate basis)</span>}
        {showMA && sales.length >= 3 && <span><i className="lg lg-ma" /> 5-sale average</span>}
        {floor != null && <span><i className="lg lg-floor" /> cheapest live Buy-It-Now</span>}
      </div>
    </div>
  );
}

/* ---------------- scatter: pop vs price ---------------- */
function Scatter({ rows, onPick }) {
  const [wrapRef, cw] = useMeasure();
  const [hover, setHover] = useState(null);
  const W = Math.max(300, cw || 640), h = 280;
  const padL = 58, padR = 20, padT = 16, padB = 36;
  const pts = rows.filter((r) => r.c.pop && r.r.st);
  if (pts.length < 2) return null;
  const lx = (v) => Math.log10(Math.max(v, 1));
  const xs = pts.map((p) => lx(p.c.pop.psa10)), ys = pts.map((p) => lx(p.r.st.latest));
  const x0 = Math.min(...xs) - 0.1, x1 = Math.max(...xs) + 0.1, y0 = Math.min(...ys) - 0.1, y1 = Math.max(...ys) + 0.1;
  const sx = (v) => padL + ((lx(v) - x0) / (x1 - x0)) * (W - padL - padR);
  const sy = (v) => padT + (1 - (lx(v) - y0) / (y1 - y0)) * (h - padT - padB);
  const xt = [2, 5, 10, 20, 50, 100, 200].filter((v) => lx(v) >= x0 && lx(v) <= x1);
  const yt = [1000, 2000, 5000, 10000, 20000, 50000].filter((v) => lx(v) >= y0 && lx(v) <= y1);
  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg width={W} height={h} viewBox={`0 0 ${W} ${h}`} onMouseLeave={() => setHover(null)}>
        {yt.map((v) => <g key={v}><line x1={padL} x2={W - padR} y1={sy(v)} y2={sy(v)} className="grid" /><text x={padL - 8} y={sy(v) + 3.5} className="axis-y">{moneyShort(v)}</text></g>)}
        {xt.map((v) => <g key={v}><line y1={padT} y2={h - padB} x1={sx(v)} x2={sx(v)} className="grid" /><text x={sx(v)} y={h - 14} className="axis-x" style={{ textAnchor: "middle" }}>{v}</text></g>)}
        <text x={W - padR} y={h - 2} className="axis-x" style={{ textAnchor: "end" }}>PSA 10 population (log) →</text>
        {pts.map((p) => (
          <g key={p.c.id} onMouseEnter={() => setHover(p)} onClick={() => onPick(p.c.id)} style={{ cursor: "pointer" }}>
            <circle cx={sx(p.c.pop.psa10)} cy={sy(p.r.st.latest)} r={hover === p ? 8 : 6} className={"dot tier-" + p.r.tier.k} />
            <text x={sx(p.c.pop.psa10) + 9} y={sy(p.r.st.latest) + 4} className="dot-lbl">{p.c.champion}</text>
          </g>
        ))}
      </svg>
      {hover && (
        <div className="tip" style={{ left: Math.min(Math.max(sx(hover.c.pop.psa10), 90), W - 90), top: sy(hover.r.st.latest) - 10 }}>
          <b>{hover.c.champion} · {money(hover.r.st.latest)}</b>
          <span>{hover.c.pop.psa10} PSA 10 · Rift Score {hover.r.score} ({hover.r.tier.label})</span>
        </div>
      )}
      <div className="legend">
        <span>Last confirmed PSA 10 sale (log) against PSA 10 population (log). Only cards with both a population reading and a sale appear.</span>
      </div>
    </div>
  );
}

/* ---------------- forms ---------------- */
function SaleForm({ onSave, onCancel }) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [price, setPrice] = useState("");
  const [url, setUrl] = useState("");
  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Log a confirmed sale</h3>
        <p className="modal-note">Only a sale that actually closed, in USD. Paste the listing link so it can be checked later.</p>
        <div className="row2">
          <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label>Price (USD)<input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" autoFocus /></label>
        </div>
        <label>Listing URL<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.ebay.com/itm/…" /></label>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={() => price && onSave({ date, price: parseFloat(price), source: "manual", via: "manual", url: url || undefined, type: "manual" })}>Add sale</button>
        </div>
      </div>
    </div>
  );
}

function MethodModal({ onClose }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>How the Rift Score works</h3>
        <div className="method">
          <p>What makes a metal card worth chasing? Not its ask price — anyone can type a number into eBay — but the gap between what people are <em>paying</em> and what the card's own arithmetic says it should fetch. The Rift Score is one number, 0 to 100, built from five measurements that each answer a smaller version of that question.</p>
          <ol>
            <li><b>Scarcity (25%)</b> — the PSA 10 population, on a log scale. Two gems in the world score near 90; a hundred and fifty score near 10. Rarity is the floor under everything else.</li>
            <li><b>Momentum (25%)</b> — a least-squares trend through the confirmed PSA 10 sales of the last 120 days. Three or more sales earn full weight; two sales earn half; one sale, honestly, tells you nothing about direction.</li>
            <li><b>Liquidity (15%)</b> — how many confirmed sales closed in the last 90 days. A card you cannot exit is a card you do not own so much as hold.</li>
            <li><b>Entry gap (20%)</b> — the cheapest live Buy-It-Now against the median of the last three sales. A floor 40% under recent sales scores 100; a floor at parity scores 60; a floor 60% over scores 0. Auctions are excluded here because a current bid is not an ask.</li>
            <li><b>Gem premium (15%)</b> — the last PSA 10 sale divided by the raw metal card's TCGplayer market price. A gem trading near raw is under-appreciated; one at six times raw has the grading arbitrage fully priced in.</li>
          </ol>
          <p>Any part that cannot be measured sits at a neutral 50 and is marked <em>n/a</em> rather than quietly invented. Then the blend is discounted by confidence — how many confirmed sales exist — so a card with zero sales can never outrank one with a real record on hunches alone. Tiers: <b>Prime</b> 60+, <b>Watch</b> 44+, <b>Hold</b> 34+, otherwise <b>Pass</b>.</p>
          <p>Two honesty rules sit underneath all of it. Only completed sales count — never an active listing, never an ended-unsold one, never a hidden Best Offer figure — and only the Plated Legends printing counts, so the foil release-event promos that share a card number are filtered out by title. The score is a lens, not a verdict; the sales table beneath every chart is where the real argument lives.</p>
        </div>
        <div className="modal-actions"><button className="btn primary" onClick={onClose}>Got it</button></div>
      </div>
    </div>
  );
}

/* ---------------- sidebar row ---------------- */
function CardRow({ card, r, active, onClick }) {
  const sales = sortByDate(card.sales);
  return (
    <button className={"row" + (active ? " row-active" : "")} onClick={onClick}>
      <div className="row-main">
        <div className="row-title"><SetChip s={card.set} /> {card.champion} <span className="row-num">#{card.number}</span></div>
        <div className="row-sub">
          {r.st ? <>Last {money(r.st.latest)} · {ageLabel(r.st.lastDate)} · {sales.length} sale{sales.length !== 1 ? "s" : ""}</> : <span className="unpriced">no confirmed PSA 10 sale</span>}
          {card.pop && <> · pop {card.pop.psa10}</>}
        </div>
      </div>
      <Sparkline sales={sales} />
      <div className="row-right"><ScorePill r={r} small /></div>
    </button>
  );
}

/* ---------------- board (ranking) ---------------- */
function Board({ rows, totals, onPick, asOf }) {
  return (
    <div className="board">
      <div className="board-head">
        <div>
          <h2>Where the opportunity sits</h2>
          <p>Every Plated Legend ranked by Rift Score. Cards without a confirmed PSA 10 sale are held down by the confidence discount, on purpose — a rare card nobody has actually paid for is a question, not an answer.</p>
        </div>
      </div>
      <div className="tiles">
        <div className="tile"><b>{totals.cards}</b><span>Plated Legends tracked</span></div>
        <div className="tile"><b>{totals.sales}</b><span>confirmed PSA 10 sales</span></div>
        <div className="tile"><b>{totals.priced}</b><span>cards with ≥1 sale</span></div>
        <div className="tile"><b>{totals.auctions}</b><span>live auctions to confirm</span></div>
        <div className="tile"><b>{fmtDate(asOf)}</b><span>data as of</span></div>
      </div>
      <Scatter rows={rows} onPick={onPick} />
      <div className="rank-table">
        <div className="rt-head"><span>#</span><span>Card</span><span>Score</span><span>Last sale</span><span>120d trend</span><span>Sales</span><span>Pop 10</span><span>Floor ask</span><span>Premium</span></div>
        {rows.map(({ c, r }, i) => (
          <button className="rt-row" key={c.id} onClick={() => onPick(c.id)}>
            <span className="rt-rank">{i + 1}</span>
            <span className="rt-card"><SetChip s={c.set} /> <b>{c.champion}</b> <em>{c.title} · #{c.number}/{c.of}</em></span>
            <span className="rt-score"><i className={"bar tier-" + r.tier.k} style={{ width: r.score + "%" }} /><ScorePill r={r} small /></span>
            <span className="mono">{r.st ? moneyShort(r.st.latest) : <em className="unpriced">unpriced</em>}</span>
            <span><TrendChip v={r.trend} small /></span>
            <span className="mono">{c.sales.length}</span>
            <span className="mono">{c.pop ? c.pop.psa10 : "—"}</span>
            <span className="mono">{r.floor != null ? moneyShort(r.floor) : "—"}</span>
            <span className="mono">{r.st && c.rawMarket ? (r.st.latest / c.rawMarket.price).toFixed(1) + "×" : "—"}</span>
          </button>
        ))}
      </div>
      <p className="foot-note">Premium = last PSA 10 sale ÷ TCGplayer market price of the raw metal card. Floor ask = cheapest live Buy-It-Now for a PSA 10 copy on eBay, seen {fmtDate(asOf)}. Populations are PSA's own counts, read from eBay's PSA data widget.</p>
    </div>
  );
}

/* ---------------- detail ---------------- */
function Detail({ card, r, onBack, onLogSale }) {
  const [range, setRange] = useState("all");
  const [showMA, setShowMA] = useState(true);
  const [showRaw, setShowRaw] = useState(true);
  const [saleOpen, setSaleOpen] = useState(false);
  const allSales = sortByDate(card.sales);
  const allRaw = sortByDate(card.rawSales);
  const days = RANGES.find((x) => x.k === range).days;
  const sales = withinRange(allSales, days);
  const raw = withinRange(allRaw, days);
  const st = seriesStats(sales.length ? sales : allSales);
  const bins = (card.asks || []).filter((a) => a.type === "bin");
  const aucs = (card.asks || []).filter((a) => a.type === "auction");

  return (
    <div className="detail">
      <button className="back" onClick={onBack}>◀ Board</button>
      <div className="detail-head">
        <div>
          <div className="detail-title"><SetChip s={card.set} /> {card.champion}, {card.title} <span className="grade">PSA 10</span></div>
          <div className="detail-meta">
            Plated Legend · {card.setName} #{card.number}/{card.of}
            {card.pop ? <> · PSA 10 pop <b>{card.pop.psa10}</b> of {card.pop.total} graded</> : <> · no PSA population reading yet</>}
            {card.rawMarket && <> · raw metal market {moneyShort(card.rawMarket.price)}</>}
          </div>
        </div>
        <div className="detail-actions">
          <ScorePill r={r} />
          <button className="btn ghost sm" onClick={() => setSaleOpen(true)}>+ Sale</button>
        </div>
      </div>

      <div className="stat-strip">
        <Stat label="Last sale" value={st ? money(st.latest) : "—"} sub={st ? "sold " + ageLabel(st.lastDate) : "no confirmed sale"} />
        <Stat label="Trend" value={<TrendChip v={st ? st.trendPct : null} />} sub={st && st.count >= 2 ? `regression, ${st.count} sales` : "needs 2+ sales"} />
        <Stat label="Median" value={st ? money(st.median) : "—"} sub={st ? `range ${moneyShort(st.min)} – ${moneyShort(st.max)}` : ""} />
        <Stat label="Floor ask" value={r.floor != null ? money(r.floor) : "—"} sub={bins.length ? `${bins.length} Buy-It-Now live` : "no Buy-It-Now live"} />
      </div>

      <div className="chart-controls">
        <div className="seg">{RANGES.map((x) => <button key={x.k} className={"seg-btn" + (range === x.k ? " on" : "")} onClick={() => setRange(x.k)}>{x.label}</button>)}</div>
        <div className="toggles">
          <label className="ma-toggle"><input type="checkbox" checked={showMA} onChange={(e) => setShowMA(e.target.checked)} /> 5-sale avg</label>
          {allRaw.length > 0 && <label className="ma-toggle"><input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} /> raw metal sales</label>}
        </div>
      </div>
      <PriceChart sales={sales.length ? sales : allSales} rawSales={raw.length ? raw : allRaw} floor={r.floor} showMA={showMA} showRaw={showRaw} />

      <div className="score-box">
        <div className="score-head">
          <div><div className="stat-label">Rift Score breakdown</div><div className="score-big">{r.score} <small>/ 100 · {r.tier.label}</small></div></div>
          <div className="score-conf">blend {r.blended} × confidence {Math.round(r.conf * 100)}%<br /><em>{allSales.length} confirmed sale{allSales.length !== 1 ? "s" : ""}{card.pop ? "" : " · pop unknown"}</em></div>
        </div>
        {r.parts.map((p) => (
          <div className="part" key={p.k}>
            <span className="part-lbl">{p.label} <em>{Math.round(WEIGHTS[p.k] * 100)}%</em></span>
            <span className="part-bar"><i className={p.na ? "na" : ""} style={{ width: p.v + "%" }} /></span>
            <span className="part-v mono">{p.na ? "n/a" : Math.round(p.v)}</span>
            <span className="part-d">{p.detail}</span>
          </div>
        ))}
      </div>

      <div className="sales-table">
        <div className="st-title">Confirmed PSA 10 sales <em>{allSales.length}</em></div>
        {allSales.length === 0 && <div className="st-empty">Nothing confirmed yet. Live asks below are context, not price.</div>}
        {allSales.length > 0 && <div className="st-head"><span>Date</span><span>Price</span><span>How</span><span>Source</span></div>}
        {[...allSales].reverse().map((s, i) => (
          <div className="st-row" key={i}>
            <span>{fmtDate(s.date)} <em>· {ageLabel(s.date)}</em>{s.note && <div className="st-note">{s.note}</div>}</span>
            <span className="mono">{money(s.price)}{s.listed && <em className="listed"> listed {moneyShort(s.listed)}</em>}</span>
            <span className="how">{s.type === "auction" ? `auction${s.bids ? ` · ${s.bids} bids` : ""}` : s.type === "offer" ? "best offer" : s.type === "bin" ? "buy it now" : s.type || "—"}</span>
            <span className={"src src-" + (s.source || "ebay")}>{s.url ? <a href={s.url} target="_blank" rel="noopener" title={"via " + (s.via || "listing page")}>{s.source}{s.via === "pricecharting" ? " · pc" : s.via === "130point" ? " · 130" : ""} ↗</a> : s.source}</span>
          </div>
        ))}
      </div>

      {(bins.length > 0 || aucs.length > 0) && (
        <div className="sales-table asks">
          <div className="st-title">Live listings <em>seen {fmtDate(card.asks[0].seen)} · not sales</em></div>
          <div className="st-head"><span>Listing</span><span>Price</span><span>Type</span><span></span></div>
          {[...aucs, ...bins].map((a, i) => (
            <div className="st-row" key={i}>
              <span className="ask-title">{a.title}</span>
              <span className="mono">{money(a.price)}</span>
              <span className="how">{a.type === "auction" ? `auction${a.bids != null ? ` · ${a.bids} bids` : ""}${a.ends ? ` · ends ${fmtDateShort(a.ends)}` : ""}` : "buy it now"}</span>
              <span className="src src-ebay"><a href={a.url} target="_blank" rel="noopener">ebay ↗</a></span>
            </div>
          ))}
        </div>
      )}

      <div className="refresh-hint small">
        Out of date? Ask Claude: <code>refresh prizewall "{card.query}"</code> and confirmed solds, live asks and the PSA pop get appended here.
      </div>
      {saleOpen && <SaleForm onSave={(s) => { onLogSale(s); setSaleOpen(false); }} onCancel={() => setSaleOpen(false)} />}
    </div>
  );
}

/* ---------------- app ---------------- */
function App() {
  const [data, setData] = useState({ updatedAt: 0, cards: [] });
  const [loaded, setLoaded] = useState(false);
  const [selId, setSelId] = useState(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("score");
  const [setF, setSetF] = useState("all");
  const [pricedOnly, setPricedOnly] = useState(false);
  const [method, setMethod] = useState(false);
  const [sync, setSync] = useState(null); // {running, done, total, added, card, error, finishedAt}
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    (async () => {
      let file = null;
      try { file = await (await fetch("prizewall.json?t=" + Date.now(), { cache: "no-store" })).json(); } catch {}
      const local = loadLocal();
      let chosen = file || { updatedAt: 0, cards: [] };
      if (local && (local.updatedAt || 0) > (chosen.updatedAt || 0)) chosen = local;
      setData(chosen);
      setLoaded(true);
      // automatic sweep when the last 130point sync is older than a day (or never happened)
      if (chosen.cards.some((c) => Date.now() - (c.synced130 || 0) > SYNC_TTL)) setTimeout(() => runSync(), 800);
    })();
  }, []);

  const commit = useCallback((next) => { const stamped = { ...next, updatedAt: Date.now() }; setData(stamped); saveLocal(stamped); return stamped; }, []);

  /* Incremental sweep. 130point allows only a few dozen queries an hour, so each pass works through the
     cards that were synced longest ago, stamps each finished card with synced130, and when 130point says
     stop it saves what it has and schedules itself to resume the moment the window reopens. */
  const resumeTimer = useRef(null);
  const runSync = useCallback(async () => {
    const start = dataRef.current;
    if (!start.cards.length || (syncRef.current && syncRef.current.running)) return;
    if (resumeTimer.current) { clearTimeout(resumeTimer.current); resumeTimer.current = null; }
    const order = [...start.cards].sort((a, b) => (a.synced130 || 0) - (b.synced130 || 0));
    const total = order.length;
    const already = order.filter((c) => Date.now() - (c.synced130 || 0) < SYNC_TTL).length;
    setSync({ running: true, done: already, total, added: 0, card: "" });
    let cards = start.cards.map((c) => ({ ...c, sales: [...(c.sales || [])] }));
    const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
    let added = 0, errors = 0, paused = null, done = already;
    for (const oc of order) {
      const c = byId[oc.id];
      if (Date.now() - (c.synced130 || 0) < SYNC_TTL) continue; // fresh enough — spend the budget elsewhere
      setSync((s) => ({ ...s, done, added, card: c.champion }));
      let rows = [], complete = true;
      for (const q of queriesFor(c)) {
        try { rows = rows.concat(await fetch130(q)); }
        catch (e) {
          if (e instanceof RateLimited) { paused = Date.now() + e.retryAfter * 1000; complete = false; break; }
          errors++; complete = false;
        }
      }
      const seen = new Set();
      rows = rows.filter((r) => { const k = r.ebayId || r.title + r.date + r.price; if (seen.has(k)) return false; seen.add(k); return true; });
      const fresh = mergeRows(c, rows);
      if (fresh.length) { c.sales = sortByDate(c.sales.concat(fresh)); added += fresh.length; }
      if (complete) { c.synced130 = Date.now(); done++; }
      if (paused) break;
    }
    const asOf = new Date().toISOString().slice(0, 10);
    const allDone = cards.every((c) => Date.now() - (c.synced130 || 0) < SYNC_TTL);
    const next = commit({ ...dataRef.current, cards, syncedAt: allDone ? Date.now() : dataRef.current.syncedAt, asOf: added ? asOf : dataRef.current.asOf });
    const saved = await saveToServer(next);
    setSync({ running: false, done, total, added, errors, saved, paused, finishedAt: Date.now() });
    if (paused) resumeTimer.current = setTimeout(() => runSync(), paused - Date.now() + 8000);
  }, [commit]);
  const syncRef = useRef(null);
  syncRef.current = sync;
  const logSale = (id, sale) => commit({ ...data, cards: data.cards.map((x) => (x.id === id ? { ...x, sales: [...(x.sales || []), sale] } : x)) });

  const cards = data.cards || [];
  const scored = useMemo(() => cards.map((c) => ({ c, r: riftScore(c) })), [cards]);

  const shown = useMemo(() => {
    let list = scored;
    if (setF !== "all") list = list.filter((x) => x.c.set === setF);
    if (pricedOnly) list = list.filter((x) => x.c.sales.length);
    if (q.trim()) { const t = q.toLowerCase(); list = list.filter((x) => (x.c.champion + " " + x.c.title + " " + x.c.set + " " + x.c.number).toLowerCase().includes(t)); }
    const last = (x) => (x.c.sales.length ? toDays(sortByDate(x.c.sales).slice(-1)[0].date) : -1);
    list = [...list].sort((a, b) => {
      if (sort === "score") return b.r.score - a.r.score || (b.r.st?.latest || 0) - (a.r.st?.latest || 0);
      if (sort === "value") return (b.r.st?.latest || 0) - (a.r.st?.latest || 0);
      if (sort === "trend") return (b.r.st?.trendPct ?? -9) - (a.r.st?.trendPct ?? -9);
      if (sort === "pop") return (a.c.pop?.psa10 ?? 9999) - (b.c.pop?.psa10 ?? 9999);
      if (sort === "recent") return last(b) - last(a);
      if (sort === "set") return SET_ORDER.indexOf(a.c.set) - SET_ORDER.indexOf(b.c.set) || a.c.number.localeCompare(b.c.number);
      return a.c.champion.localeCompare(b.c.champion);
    });
    return list;
  }, [scored, q, sort, setF, pricedOnly]);

  const totals = useMemo(() => ({
    cards: cards.length,
    sales: cards.reduce((a, c) => a + c.sales.length, 0),
    priced: cards.filter((c) => c.sales.length).length,
    auctions: cards.reduce((a, c) => a + (c.asks || []).filter((x) => x.type === "auction").length, 0),
  }), [cards]);

  const selected = scored.find((x) => x.c.id === selId) || null;
  if (!loaded) return <div className="loading">Loading the prize wall…</div>;

  return (
    <div className="app">
      <style>{CSS}</style>
      <header className="topbar">
        <div className="brand" onClick={() => setSelId(null)} style={{ cursor: "pointer" }}>
          <div className="logo">▣</div>
          <div><h1>Prizewall</h1><div className="tag">Riftbound Plated Legends · PSA 10 · confirmed sales only · USD</div></div>
        </div>
        <div className="top-summary">
          <div className="ts"><span className="ts-v">{totals.sales}</span><span className="ts-l">confirmed sales</span></div>
          <div className="ts"><span className="ts-v">{totals.priced}<small>/{totals.cards}</small></span><span className="ts-l">cards priced</span></div>
          <div className="ts"><span className="ts-v">{data.asOf ? fmtDateShort(data.asOf) : "—"}</span><span className="ts-l">as of</span></div>
        </div>
        <div className="top-actions">
          <button className="btn ghost" onClick={() => setMethod(true)}>How the score works</button>
          <button className="btn primary" disabled={sync && sync.running} onClick={runSync}>{sync && sync.running ? "Syncing…" : "Sync 130point"}</button>
        </div>
      </header>
      {sync && (
        <div className={"syncbar" + (sync.running ? " running" : sync.paused ? " paused" : sync.errors ? " warn" : " ok")}>
          {sync.running ? (
            <>
              <span className="spin" /> Checking 130point card by card… <b>{sync.done}/{sync.total}</b> up to date {sync.card && <em>· now {sync.card}</em>} · {sync.added} new sale{sync.added === 1 ? "" : "s"} this pass
              <i className="syncprog" style={{ width: (100 * sync.done) / sync.total + "%" }} />
            </>
          ) : sync.paused ? (
            <>
              130point's hourly limit paused the sweep at <b>{sync.done}/{sync.total}</b> cards · {sync.added} new sale{sync.added === 1 ? "" : "s"} saved so far · it resumes on its own at <b>{fmtClock(sync.paused)}</b> if this tab stays open
              <i className="syncprog" style={{ width: (100 * sync.done) / sync.total + "%" }} />
              <button className="linkbtn" onClick={() => setSync(null)}>dismiss</button>
            </>
          ) : (
            <>
              All <b>{sync.total}</b> cards checked against 130point: <b>{sync.added}</b> new confirmed sale{sync.added === 1 ? "" : "s"} this pass
              {sync.errors ? ` · ${sync.errors} quer${sync.errors === 1 ? "y" : "ies"} failed` : ""}
              {sync.saved ? " · saved to prizewall.json" : " · kept in this browser only (server save failed)"}
              <button className="linkbtn" onClick={() => setSync(null)}>dismiss</button>
            </>
          )}
        </div>
      )}
      {!sync && cards.length > 0 && <div className="synced-note">{cards.filter((c) => Date.now() - (c.synced130 || 0) < SYNC_TTL).length}/{cards.length} cards checked against 130point in the last day · the sweep runs by itself while the site is open</div>}

      <div className="body">
        <aside className="side">
          <div className="side-controls">
            <input className="search" placeholder="Search champions…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="sortsel" value={sort} onChange={(e) => setSort(e.target.value)}>{SORTS.map((s) => <option key={s.k} value={s.k}>{s.label}</option>)}</select>
          </div>
          <div className="filters">
            {["all", ...SET_ORDER].map((s) => <button key={s} className={"fchip" + (setF === s ? " on" : "")} onClick={() => setSetF(s)}>{s === "all" ? "All sets" : SET_LABEL[s]}</button>)}
            <button className={"fchip" + (pricedOnly ? " on" : "")} onClick={() => setPricedOnly(!pricedOnly)}>Priced only</button>
          </div>
          <div className="rows">
            {shown.length === 0 && <div className="side-empty">Nothing matches.</div>}
            {shown.map(({ c, r }) => <CardRow key={c.id} card={c} r={r} active={c.id === selId} onClick={() => setSelId(c.id)} />)}
          </div>
        </aside>
        <main className="content">
          {selected ? (
            <Detail key={selected.c.id} card={selected.c} r={selected.r} onBack={() => setSelId(null)} onLogSale={(s) => logSale(selected.c.id, s)} />
          ) : (
            <Board rows={shown} totals={totals} onPick={setSelId} asOf={data.asOf || new Date().toISOString().slice(0, 10)} />
          )}
        </main>
      </div>
      {method && <MethodModal onClose={() => setMethod(false)} />}
    </div>
  );
}

/* ---------------- styles ---------------- */
const CSS = `
:root{
  --paper:#f4f1ea; --card:#fffdf9; --ink:#242019; --ink-soft:#6b6152; --ink-faint:#a89e8c;
  --line:#e7e0d3; --line-soft:#efe9dd;
  --accent:#3a5a78; --accent-deep:#26405a; --gold:#b8892c; --gold-bg:#f6ecd2;
  --up:#2f7d5b; --down:#b4463c; --flat:#8a8170;
  --up-bg:#e5f0ea; --down-bg:#f6e7e4; --flat-bg:#efeadf;
  --shadow:0 1px 2px rgba(60,50,30,.05),0 6px 20px rgba(60,50,30,.06);
}
*{box-sizing:border-box}
.app{font-family:Inter,system-ui,sans-serif;color:var(--ink);max-width:1260px;margin:0 auto;padding:18px 20px 60px}
.loading{font-family:Inter,sans-serif;padding:60px;text-align:center;color:var(--ink-soft)}
h1{font-family:Fraunces,serif;font-weight:600;font-size:26px;margin:0;letter-spacing:-.01em}
h2{font-family:Fraunces,serif;font-weight:600;font-size:22px;margin:0 0 6px;letter-spacing:-.01em}
.mono{font-family:'Roboto Mono',monospace}
a{color:var(--accent-deep)}

.topbar{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:42px;height:42px;border-radius:12px;background:linear-gradient(150deg,#5d6b7a,#2b3540);color:#fdfbf5;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:var(--shadow)}
.tag{font-size:12.5px;color:var(--ink-soft);margin-top:1px}
.top-summary{display:flex;gap:22px;margin-left:8px}
.ts{display:flex;flex-direction:column}
.ts-v{font-family:Fraunces,serif;font-size:18px;font-weight:600}
.ts-v small{font-size:13px;color:var(--ink-faint);font-weight:500}
.ts-l{font-size:11px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.04em}
.top-actions{margin-left:auto;display:flex;gap:8px}
.btn:disabled{opacity:.6;cursor:wait;transform:none}
.syncbar{position:relative;overflow:hidden;font-size:12.5px;padding:9px 14px;border-radius:10px;margin:-6px 0 14px;border:1px solid var(--line);background:#f7f3ea;color:var(--ink-soft);display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.syncbar.ok{background:var(--up-bg);border-color:#bfd9cc;color:#25604d}
.syncbar.warn{background:#f6efdd;border-color:#e6d3a3;color:#7a5a12}
.syncbar.paused{background:#f6efdd;border-color:#e6d3a3;color:#7a5a12}
.syncbar b{color:var(--ink)}.syncbar em{font-style:normal;color:var(--ink-faint)}
.syncprog{position:absolute;left:0;bottom:0;height:3px;background:var(--accent);transition:width .3s}
.spin{width:12px;height:12px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.linkbtn{margin-left:auto;background:none;border:none;font-family:Inter;font-size:12px;color:inherit;text-decoration:underline;cursor:pointer}
.synced-note{font-size:11.5px;color:var(--ink-faint);margin:-8px 0 12px}

.btn{font-family:Inter,sans-serif;font-size:13.5px;font-weight:600;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:9px 15px;border-radius:9px;cursor:pointer;transition:.12s}
.btn:hover{border-color:#d8cfbe;transform:translateY(-1px)}
.btn.primary{background:linear-gradient(150deg,var(--accent),var(--accent-deep));color:#fdfbf5;border:none;box-shadow:var(--shadow)}
.btn.ghost{background:transparent}
.btn.sm{padding:6px 11px;font-size:12.5px}
.back{font-family:Inter;font-size:12.5px;font-weight:600;color:var(--ink-soft);background:none;border:none;padding:0 0 10px;cursor:pointer}
.back:hover{color:var(--accent)}

.body{display:grid;grid-template-columns:350px 1fr;gap:20px;align-items:start}
@media(max-width:860px){.body{grid-template-columns:1fr}.top-summary{display:none}}

.side-controls{display:flex;gap:8px;margin-bottom:8px}
.search{flex:1;font-family:Inter;font-size:13.5px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;background:var(--card)}
.sortsel{font-family:Inter;font-size:12.5px;padding:0 8px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--ink-soft)}
.search:focus,.sortsel:focus{outline:none;border-color:var(--accent)}
.filters{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}
.fchip{font-family:Inter;font-size:11.5px;font-weight:600;border:1px solid var(--line);background:var(--card);color:var(--ink-soft);padding:4px 9px;border-radius:999px;cursor:pointer}
.fchip.on{background:var(--ink);color:#fdfbf5;border-color:var(--ink)}
.rows{display:flex;flex-direction:column;gap:7px}
.side-empty{color:var(--ink-soft);font-size:13px;padding:24px 8px;text-align:center}

.row{display:flex;align-items:center;gap:10px;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:9px 11px;cursor:pointer;transition:.12s;box-shadow:var(--shadow);font-family:Inter}
.row:hover{transform:translateY(-1px);border-color:#dcd3c2}
.row-active{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent),var(--shadow)}
.row-main{flex:1;min-width:0}
.row-title{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-num{color:var(--ink-faint);font-weight:500;font-size:12px}
.row-sub{font-size:11px;color:var(--ink-soft);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.unpriced{color:var(--ink-faint);font-style:italic}
.row-right{display:flex;flex-direction:column;align-items:flex-end;min-width:64px}
.spark{flex-shrink:0}
.spark-empty{border-radius:6px;background:repeating-linear-gradient(45deg,#f2ede2,#f2ede2 4px,#f6f2e9 4px,#f6f2e9 8px);flex-shrink:0}

.setchip{display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.05em;padding:1px 5px;border-radius:4px;vertical-align:middle;margin-right:2px;color:#fff}
.set-OGN{background:#5b6b8a}.set-OGS{background:#7a6a55}.set-SFD{background:#6a5b8a}.set-UNL{background:#4e7a6a}
.grade{font-size:11px;font-weight:600;color:var(--accent-deep);background:#e6ebf0;padding:1px 6px;border-radius:5px;margin-left:4px;vertical-align:middle}

.chip{display:inline-flex;align-items:center;gap:3px;font-size:12px;font-weight:600;padding:2px 7px;border-radius:6px}
.chip-sm{font-size:11px;padding:1px 6px}
.chip-up{color:var(--up);background:var(--up-bg)}
.chip-down{color:var(--down);background:var(--down-bg)}
.chip-flat{color:var(--flat);background:var(--flat-bg)}

.score-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px;border:1px solid transparent}
.score-pill b{font-family:'Roboto Mono',monospace;font-size:13px}
.score-pill.sm{font-size:10.5px;padding:2px 7px;gap:5px}.score-pill.sm b{font-size:12px}
.tier-prime{color:#7a5a12;background:var(--gold-bg);border-color:#e6d3a3}
.tier-watch{color:#25604d;background:#e3efe9;border-color:#bfd9cc}
.tier-hold{color:#5f5a50;background:#eeeae1;border-color:#dcd5c7}
.tier-pass{color:#8c4a42;background:#f4e6e3;border-color:#e6c9c3}

.content{min-height:400px}
.board,.detail{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px 24px;box-shadow:var(--shadow)}
.board-head p{color:var(--ink-soft);font-size:13.5px;line-height:1.55;margin:0 0 16px;max-width:720px}
.tiles{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:14px}
@media(max-width:700px){.tiles{grid-template-columns:repeat(2,1fr)}}
.tile{background:#f7f3ea;border:1px solid var(--line-soft);border-radius:10px;padding:10px 12px}
.tile b{display:block;font-family:Fraunces,serif;font-weight:600;font-size:20px}
.tile span{font-size:11px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.04em}

.rank-table{margin-top:18px;border-top:1px solid var(--line-soft)}
.rt-head,.rt-row{display:grid;grid-template-columns:28px 1fr 150px 84px 74px 48px 56px 84px 64px;gap:10px;align-items:center;padding:8px 4px}
.rt-head{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint);padding-top:12px}
.rt-row{font-family:Inter;font-size:13px;border:none;border-top:1px solid var(--line-soft);background:transparent;text-align:left;cursor:pointer;width:100%;color:var(--ink)}
.rt-row:hover{background:#f7f3ea}
.rt-rank{font-family:'Roboto Mono',monospace;color:var(--ink-faint);font-size:12px}
.rt-card{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rt-card em{font-style:normal;color:var(--ink-faint);font-size:11.5px}
.rt-score{display:flex;align-items:center;gap:8px}
.rt-score .bar{display:block;height:6px;border-radius:3px;flex:0 0 auto;max-width:70px;opacity:.9}
.bar.tier-prime{background:var(--gold)}.bar.tier-watch{background:#3f8a6d}.bar.tier-hold{background:#b3a98f}.bar.tier-pass{background:#c98d84}
.rt-row .mono{font-size:12.5px}
@media(max-width:900px){.rt-head span:nth-child(n+7),.rt-row span:nth-child(n+7){display:none}.rt-head,.rt-row{grid-template-columns:28px 1fr 140px 84px 74px 48px}}
.foot-note{font-size:11.5px;color:var(--ink-faint);line-height:1.5;margin:14px 0 0}

.detail-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.detail-title{font-family:Fraunces,serif;font-weight:600;font-size:22px;letter-spacing:-.01em}
.detail-meta{font-size:12.5px;color:var(--ink-soft);margin-top:4px}
.detail-actions{display:flex;gap:9px;align-items:center}

.stat-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:20px 0 8px;padding:16px 0;border-top:1px solid var(--line-soft);border-bottom:1px solid var(--line-soft)}
@media(max-width:560px){.stat-strip{grid-template-columns:repeat(2,1fr)}}
.stat-label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-soft);margin-bottom:5px}
.stat-value{font-family:Fraunces,serif;font-weight:600;font-size:19px}
.stat-sub{font-size:11.5px;color:var(--ink-faint);margin-top:3px}

.chart-controls{display:flex;justify-content:space-between;align-items:center;margin:16px 0 4px;flex-wrap:wrap;gap:8px}
.seg{display:inline-flex;background:#f0ebe0;border-radius:9px;padding:3px}
.seg-btn{font-family:Inter;font-size:12.5px;font-weight:600;border:none;background:transparent;color:var(--ink-soft);padding:6px 13px;border-radius:7px;cursor:pointer}
.seg-btn.on{background:var(--card);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.toggles{display:flex;gap:14px}
.ma-toggle{font-size:12.5px;color:var(--ink-soft);display:flex;align-items:center;gap:6px;cursor:pointer}

.chart-wrap{position:relative;margin:6px 0 4px}
.chart-wrap svg{display:block;width:100%}
.chart-empty{padding:50px 20px;text-align:center;color:var(--ink-soft);font-size:14px;background:#f7f3ea;border-radius:10px;margin:10px 0}
.grid{stroke:var(--line-soft);stroke-width:1}
.guide{stroke:var(--ink-faint);stroke-width:1;stroke-dasharray:3 3}
.floor{stroke:var(--gold);stroke-width:1.2;stroke-dasharray:6 4}
.floor-lbl{fill:var(--gold);font-size:10.5px;font-family:Inter;font-weight:600;text-anchor:end}
.axis-y{fill:var(--ink-faint);font-size:10.5px;font-family:'Roboto Mono',monospace;text-anchor:end}
.axis-x{fill:var(--ink-faint);font-size:10.5px;font-family:Inter}
.dot{stroke:#fff;stroke-width:1.5}
.dot.tier-prime{fill:var(--gold)}.dot.tier-watch{fill:#3f8a6d}.dot.tier-hold{fill:#b3a98f}.dot.tier-pass{fill:#c98d84}
.dot-lbl{fill:var(--ink-soft);font-size:10.5px;font-family:Inter;pointer-events:none}
.tip{position:absolute;transform:translate(-50%,-100%);background:var(--ink);color:#fdfbf5;padding:6px 9px;border-radius:8px;font-size:12px;display:flex;flex-direction:column;gap:1px;pointer-events:none;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.2)}
.tip b{font-family:'Roboto Mono',monospace;font-size:12.5px}
.tip span{font-size:10.5px;opacity:.75}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:11px;color:var(--ink-soft);margin:6px 2px 0}
.legend i{display:inline-block;width:18px;height:0;border-top:2px solid;vertical-align:middle;margin-right:5px}
.lg-psa{border-color:transparent;height:2px!important;border:none!important}
.lg-raw{border-color:var(--ink-faint);border-top-style:dashed}
.lg-ma{border-color:var(--ink-soft);border-top-style:dashed}
.lg-floor{border-color:var(--gold);border-top-style:dashed}

.score-box{margin-top:20px;background:#f7f3ea;border:1px solid var(--line-soft);border-radius:12px;padding:14px 16px}
.score-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:10px;flex-wrap:wrap}
.score-big{font-family:Fraunces,serif;font-weight:600;font-size:30px;line-height:1}
.score-big small{font-size:13px;color:var(--ink-soft);font-weight:500}
.score-conf{font-size:11.5px;color:var(--ink-soft);text-align:right;line-height:1.45}
.score-conf em{color:var(--ink-faint);font-style:normal}
.part{display:grid;grid-template-columns:120px 1fr 34px 1.6fr;gap:10px;align-items:center;padding:5px 0;font-size:12px}
@media(max-width:700px){.part{grid-template-columns:100px 1fr 34px}.part-d{grid-column:1/-1;margin-top:-2px}}
.part-lbl{font-weight:600}.part-lbl em{font-style:normal;color:var(--ink-faint);font-weight:500;font-size:11px}
.part-bar{display:block;height:8px;background:#e9e2d3;border-radius:4px;overflow:hidden}
.part-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),#5f86a8);border-radius:4px}
.part-bar i.na{background:repeating-linear-gradient(45deg,#cfc7b6,#cfc7b6 3px,#e2dbcb 3px,#e2dbcb 6px)}
.part-v{text-align:right;font-size:12px}
.part-d{color:var(--ink-soft);font-size:11.5px}

.sales-table{margin-top:22px;border-top:1px solid var(--line-soft)}
.st-title{font-family:Fraunces,serif;font-weight:600;font-size:16px;padding-top:14px}
.st-title em{font-style:normal;font-family:Inter;font-size:11.5px;color:var(--ink-faint);font-weight:500;margin-left:6px}
.st-empty{font-size:12.5px;color:var(--ink-soft);padding:10px 2px 4px}
.st-head,.st-row{display:grid;grid-template-columns:1.4fr auto 150px 84px;gap:12px;align-items:center;padding:8px 2px}
.st-head{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-faint);padding-top:12px}
.st-row{font-size:13px;border-top:1px solid var(--line-soft)}
.st-row em{color:var(--ink-faint);font-style:normal;font-size:11.5px}
.st-row .mono{text-align:right}
.st-row .listed{display:block;text-align:right;font-size:10.5px;text-decoration:line-through}
.st-note{font-size:11px;color:var(--ink-faint);margin-top:2px;white-space:normal}
.how{font-size:11.5px;color:var(--ink-soft)}
.src{font-size:10.5px;text-transform:uppercase;letter-spacing:.03em;text-align:right;font-weight:600}
.src a{text-decoration:none}
.src-ebay{color:var(--accent)} .src-tcgplayer{color:#7a5a12} .src-manual{color:var(--ink-soft)} .src-other{color:var(--ink-soft)}
.asks .st-row{color:var(--ink-soft)}
.ask-title{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media(max-width:640px){.st-head,.st-row{grid-template-columns:1fr auto 70px}.st-head span:nth-child(3),.st-row .how{display:none}}

.refresh-hint{font-size:12.5px;color:var(--ink-soft);background:#f3efe6;border:1px dashed var(--line);border-radius:10px;padding:12px 14px;margin:18px auto 0;line-height:1.6}
.refresh-hint code{font-family:'Roboto Mono',monospace;font-size:12px;background:#fff;padding:1px 6px;border-radius:5px;border:1px solid var(--line);color:var(--accent-deep)}

.modal-back{position:fixed;inset:0;background:rgba(40,32,20,.32);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:50;padding:20px}
.modal{background:var(--card);border-radius:16px;padding:24px;width:100%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.25);max-height:90vh;overflow:auto}
.modal.wide{max-width:640px}
.modal h3{font-family:Fraunces,serif;font-weight:600;margin:0 0 12px;font-size:20px}
.modal-note{font-size:12.5px;color:var(--ink-soft);margin:0 0 14px;line-height:1.5}
.modal label{display:block;font-size:12px;font-weight:600;color:var(--ink-soft);margin-bottom:12px}
.modal input{display:block;width:100%;margin-top:5px;font-family:Inter;font-size:14px;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:#fff}
.modal input:focus{outline:none;border-color:var(--accent)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
.method{font-size:13.5px;line-height:1.6;color:var(--ink)}
.method p{margin:0 0 12px}
.method ol{padding-left:20px;margin:0 0 12px}
.method li{margin-bottom:7px}
`;

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
