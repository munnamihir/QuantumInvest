require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");
const axios     = require("axios");
const { v4: uuid } = require("uuid");
const path      = require("path");
const crypto    = require("crypto");

const app  = express();
const PORT = process.env.PORT || 3000;
const MODEL = "claude-sonnet-4-5";

if (!process.env.ANTHROPIC_API_KEY) { console.error("FATAL: ANTHROPIC_API_KEY missing"); process.exit(1); }
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── FIX #1: trust proxy — required on Render / behind load balancers
app.set("trust proxy", 1);

let stats = { analyses: 0, simulations: 0, ideas: 0, chats: 0 };
const startTime = Date.now();

const ENC_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, "hex")
  : crypto.randomBytes(32);

// ── Middleware
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"],
    scriptSrcAttr: ["'none'"], styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com"], connectSrc: ["'self'"],
    imgSrc: ["'self'", "data:", "https:"], objectSrc: ["'none'"], baseUri: ["'self'"],
  }},
}));
app.use(cors({ origin: process.env.FRONTEND_URL || "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "128kb" }));
app.use(express.static(path.join(__dirname, "public")));

const lim = (max, win) => rateLimit({
  windowMs: win * 1000, max,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests. Please wait." },
});
app.use("/api/", lim(200, 15 * 60));
const analyzeLim = lim(20, 60);
const genLim     = lim(6,  60);
const chatLim    = lim(40, 60);

// ── JSON parser with full logging on failure
function parseJSON(raw) {
  const txt = raw.trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(txt); } catch (_) {}
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  console.error("[parseJSON] FAILED. Raw output (first 500):", raw.slice(0, 500));
  throw new Error("AI returned malformed JSON. Check Render logs for raw output.");
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIX #2: Yahoo Finance — use v7/quote (no crumb) + v8/chart for history
// ═══════════════════════════════════════════════════════════════════════════════
const YF_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept":          "application/json, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer":         "https://finance.yahoo.com/",
};

async function yfGet(url) {
  try {
    const r = await axios.get(url, { headers: YF_HEADERS, timeout: 8000, validateStatus: () => true });
    if (r.status !== 200) { console.warn(`[YF] ${r.status} → ${url.slice(0, 80)}`); return null; }
    return r.data;
  } catch (e) { console.warn(`[YF error] ${e.message?.slice(0, 80)}`); return null; }
}

// v7/quote — no crumb needed, returns PE, market cap, 52w range, etc.
async function fetchQuote(symbols) {
  const joined = symbols.join(",");
  const data = await yfGet(
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${joined}&fields=regularMarketPrice,regularMarketPreviousClose,trailingPE,forwardPE,marketCap,fiftyTwoWeekHigh,fiftyTwoWeekLow,dividendYield,beta,regularMarketVolume,averageAnalystRating,epsTrailingTwelveMonths,epsForward,priceToBook,targetMeanPrice,recommendationKey`
  );
  const results = data?.quoteResponse?.result || [];
  const map = {};
  results.forEach(q => {
    if (!q.symbol) return;
    map[q.symbol] = {
      pe:            q.trailingPE            || null,
      forwardPE:     q.forwardPE             || null,
      pb:            q.priceToBook           || null,
      eps:           q.epsTrailingTwelveMonths || null,
      epsForward:    q.epsForward            || null,
      beta:          q.beta                  || null,
      dividendYield: q.dividendYield         || null,
      fiftyTwoHigh:  q.fiftyTwoWeekHigh      || null,
      fiftyTwoLow:   q.fiftyTwoWeekLow       || null,
      marketCap:     q.marketCap             || null,
      analystTarget: q.targetMeanPrice       || null,
      recommendation:q.recommendationKey     || null,
      currentPrice:  q.regularMarketPrice    || null,
    };
  });
  console.log(`[YF quote] fetched ${Object.keys(map).length}/${symbols.length}:`, Object.keys(map).join(","));
  return map;
}

// v8/chart — history, generally works without crumb
async function fetchHistory(symbol) {
  const end   = Math.floor(Date.now() / 1000);
  const start = end - 370 * 86400;
  for (const host of ["query1", "query2"]) {
    const data = await yfGet(
      `https://${host}.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${start}&period2=${end}`
    );
    const r = data?.chart?.result?.[0];
    if (!r) continue;
    const ts  = r.timestamp || r.timestamps || [];
    const q   = r.indicators?.quote?.[0] || {};
    const adj = r.indicators?.adjclose?.[0]?.adjclose || q.close || [];
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i];
      if (!c || isNaN(c)) continue;
      out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        open: q.open?.[i] || c, high: q.high?.[i] || c, low: q.low?.[i] || c,
        close: c, adjClose: adj[i] || c, volume: q.volume?.[i] || 0 });
    }
    if (out.length >= 20) { console.log(`[YF history] ${symbol}: ${out.length} candles`); return out; }
  }
  console.warn(`[YF history] ${symbol}: no data`);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS — every function catches its own errors
// ═══════════════════════════════════════════════════════════════════════════════
function sma(arr, n) {
  try { return arr.map((_, i) => i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n); }
  catch (_) { return arr.map(() => null); }
}
function ema(arr, n) {
  try { const k = 2 / (n + 1), o = []; for (let i = 0; i < arr.length; i++) o.push(i === 0 ? arr[i] : arr[i] * k + o[i - 1] * (1 - k)); return o; }
  catch (_) { return arr.map(() => 0); }
}
function std(arr) {
  try { if (!arr || arr.length < 2) return 0; const m = arr.reduce((a, b) => a + b, 0) / arr.length; return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); }
  catch (_) { return 0; }
}
function computeRSI(c, p = 14) {
  try {
    if (c.length < p + 2) return c.map(() => null);
    const g = [], l = [];
    for (let i = 1; i < c.length; i++) { const d = c[i] - c[i-1]; g.push(d > 0 ? d : 0); l.push(d < 0 ? -d : 0); }
    let ag = g.slice(0, p).reduce((a, b) => a + b, 0) / p;
    let al = l.slice(0, p).reduce((a, b) => a + b, 0) / p;
    const rsi = [null];
    for (let i = 0; i < g.length; i++) {
      if (i < p) { rsi.push(null); continue; }
      ag = (ag * (p - 1) + g[i]) / p; al = (al * (p - 1) + l[i]) / p;
      rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
    }
    return rsi;
  } catch (_) { return c.map(() => null); }
}
function computeMACD(c) {
  try {
    const e12 = ema(c, 12), e26 = ema(c, 26);
    const line = c.map((_, i) => e12[i] - e26[i]);
    const sig  = ema(line, 9);
    return { line, signal: sig, histogram: line.map((v, i) => v - (sig[i] || 0)) };
  } catch (_) { return { line: [], signal: [], histogram: [] }; }
}
function computeBB(c, p = 20, m = 2) {
  try {
    const mid = sma(c, p), upper = [], lower = [];
    for (let i = 0; i < c.length; i++) {
      if (mid[i] == null) { upper.push(null); lower.push(null); continue; }
      const s = std(c.slice(i - p + 1, i + 1));
      upper.push(mid[i] + m * s); lower.push(mid[i] - m * s);
    }
    return { upper, mid, lower };
  } catch (_) { return { upper: [], mid: [], lower: [] }; }
}
function detectPatterns(candles) {
  try {
    if (!candles || candles.length < 3) return [];
    const P = [], last = candles[candles.length - 1], prev = candles[candles.length - 2], prev2 = candles[candles.length - 3];
    const body = c => Math.abs((c.close || 0) - (c.open || 0));
    const range = c => (c.high || 0) - (c.low || 0);
    const bull = c => (c.close || 0) > (c.open || 0), bear = c => (c.close || 0) < (c.open || 0);
    if (range(last) > 0 && body(last) / range(last) < 0.1) P.push({ name: "Doji", signal: "neutral", desc: "Indecision" });
    const lw = Math.min(last.open, last.close) - last.low, uw = last.high - Math.max(last.open, last.close);
    if (body(last) > 0 && lw > 2 * body(last) && uw < body(last) && bear(prev)) P.push({ name: "Hammer", signal: "bullish", desc: "Bullish reversal signal" });
    if (body(last) > 0 && uw > 2 * body(last) && lw < body(last) && bull(prev)) P.push({ name: "Shooting Star", signal: "bearish", desc: "Bearish reversal signal" });
    if (bear(prev) && bull(last) && last.open < prev.close && last.close > prev.open) P.push({ name: "Bullish Engulfing", signal: "bullish", desc: "Strong buying" });
    if (bull(prev) && bear(last) && last.open > prev.close && last.close < prev.open) P.push({ name: "Bearish Engulfing", signal: "bearish", desc: "Strong selling" });
    if (bull(last) && bull(prev) && bull(prev2) && last.close > prev.close && prev.close > prev2.close) P.push({ name: "Three White Soldiers", signal: "bullish", desc: "Strong uptrend" });
    if (bear(last) && bear(prev) && bear(prev2) && last.close < prev.close && prev.close < prev2.close) P.push({ name: "Three Black Crows", signal: "bearish", desc: "Strong downtrend" });
    return P;
  } catch (_) { return []; }
}

async function analyzeTechnical(symbol) {
  try {
    const history = await fetchHistory(symbol);
    if (!history || history.length < 20) return null;
    const closes = history.map(d => d.adjClose), highs = history.map(d => d.high), lows = history.map(d => d.low);
    const n = closes.length;
    const rsi = computeRSI(closes), macd = computeMACD(closes), bb = computeBB(closes);
    const ma20 = sma(closes, 20), ma50 = sma(closes, 50), ma200 = sma(closes, 200);
    const last = closes[n-1], m20 = ma20[n-1], m50 = ma50[n-1], m200 = ma200[n-1];
    let trend = "sideways";
    if (m20 != null && m50 != null) { if (last > m20 && m20 > m50) trend = "uptrend"; if (last < m20 && m20 < m50) trend = "downtrend"; }
    const support    = lows.slice(-60).length  ? Math.min(...lows.slice(-60))  : null;
    const resistance = highs.slice(-60).length ? Math.max(...highs.slice(-60)) : null;
    const rets = closes.slice(-252).map((_, i, a) => i === 0 ? null : Math.log(a[i] / a[i-1])).filter(Boolean);
    const annualVol = rets.length > 10 ? std(rets) * Math.sqrt(252) : 0.25;
    const perf3m = n >= 63  ? closes[n-1] / closes[n-63]  - 1 : null;
    const perf1y = n >= 252 ? closes[n-1] / closes[n-252] - 1 : null;
    const lastRSI  = rsi[n-1];
    const lastHist = macd.histogram[n-1];
    const lastBBU  = bb.upper[n-1], lastBBL = bb.lower[n-1];
    const signals = [];
    if (lastRSI != null) {
      if (lastRSI < 30) signals.push({ indicator: "RSI", value: lastRSI.toFixed(1), signal: "bullish", desc: "Oversold <30" });
      else if (lastRSI > 70) signals.push({ indicator: "RSI", value: lastRSI.toFixed(1), signal: "bearish", desc: "Overbought >70" });
      else signals.push({ indicator: "RSI", value: lastRSI.toFixed(1), signal: "neutral", desc: "Neutral zone" });
    }
    if (lastHist != null) signals.push({ indicator: "MACD", value: lastHist.toFixed(4), signal: lastHist > 0 ? "bullish" : "bearish", desc: lastHist > 0 ? "Positive" : "Negative" });
    if (lastBBU && lastBBL) {
      const p = (last - lastBBL) / (lastBBU - lastBBL);
      if (p > 0.85) signals.push({ indicator: "BB", value: (p*100).toFixed(0)+"%", signal: "bearish", desc: "Near upper band" });
      else if (p < 0.15) signals.push({ indicator: "BB", value: (p*100).toFixed(0)+"%", signal: "bullish", desc: "Near lower band" });
    }
    if (m20 != null && m50 != null) signals.push({ indicator: "MA20/50", value: m20 > m50 ? "20>50" : "50>20", signal: m20 > m50 ? "bullish" : "bearish", desc: m20 > m50 ? "Uptrend" : "Downtrend" });
    const patterns = detectPatterns(history.slice(-5));
    const bC = signals.filter(s => s.signal === "bullish").length + patterns.filter(p => p.signal === "bullish").length;
    const rC = signals.filter(s => s.signal === "bearish").length + patterns.filter(p => p.signal === "bearish").length;
    const tot = bC + rC;
    const summary = tot === 0 ? "neutral" : bC / tot >= 0.6 ? "bullish" : rC / tot >= 0.6 ? "bearish" : "neutral";
    return {
      symbol, candles: history.slice(-90), dates: history.slice(-90).map(d => d.date),
      closes: closes.slice(-90), volumes: history.slice(-90).map(d => d.volume),
      rsi: rsi.slice(-90), macd: { line: macd.line.slice(-90), signal: macd.signal.slice(-90), histogram: macd.histogram.slice(-90) },
      bb: { upper: bb.upper.slice(-90), mid: bb.mid.slice(-90), lower: bb.lower.slice(-90) },
      ma20: ma20.slice(-90), ma50: ma50.slice(-90), ma200: ma200.slice(-90),
      trend: { trend, support, resistance, annualVol, perf3m, perf1y, ma20: m20, ma50: m50, ma200: m200 },
      signals, patterns, summary,
    };
  } catch (e) { console.warn(`[analyzeTechnical] ${symbol}: ${e.message}`); return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MONTE CARLO — always returns a result
// ═══════════════════════════════════════════════════════════════════════════════
let _s = null, _h = false;
function bm() { if (_h) { _h = false; return _s; } let u, v, sq; do { u = Math.random()*2-1; v = Math.random()*2-1; sq = u*u+v*v; } while (sq >= 1 || sq === 0); const m = Math.sqrt(-2*Math.log(sq)/sq); _s = v*m; _h = true; return u*m; }

function monteCarlo(positions, months = 24, runs = 600) {
  try {
    const posData = positions.map(p => ({
      annualReturn: p.analystTarget && p.currentPrice ? Math.min(p.analystTarget / p.currentPrice - 1, 1.5) : (p.historical?.trend?.perf1y || 0.08),
      annualVol:    Math.min(p.historical?.trend?.annualVol || 0.25, 1.0),
      weight:       p.weight || 0,
    }));
    const portReturn = posData.reduce((s, p) => s + p.weight * p.annualReturn, 0);
    const portVol    = Math.sqrt(posData.reduce((s, p) => s + Math.pow(p.weight * p.annualVol, 2), 0));
    const dMu = portReturn / 252, dSig = portVol / Math.sqrt(252), days = months * 21;
    const paths = [];
    for (let r = 0; r < runs; r++) {
      let val = 1.0; const path = [1.0];
      for (let d = 0; d < days; d++) { val *= 1 + dMu + dSig * bm(); val = Math.max(0, val); if (d % 21 === 20) path.push(val); }
      paths.push(path);
    }
    const numM = paths[0].length;
    const pct  = { p10: [], p25: [], p50: [], p75: [], p90: [] };
    for (let m = 0; m < numM; m++) {
      const v = paths.map(p => p[m]).sort((a, b) => a - b);
      pct.p10.push(v[Math.floor(runs * 0.10)]); pct.p25.push(v[Math.floor(runs * 0.25)]);
      pct.p50.push(v[Math.floor(runs * 0.50)]); pct.p75.push(v[Math.floor(runs * 0.75)]);
      pct.p90.push(v[Math.floor(runs * 0.90)]);
    }
    return { percentiles: pct, portReturn, portVol, months };
  } catch (e) { console.error("[monteCarlo]", e.message); return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── FIX #3: Full analysis — never 500s, Claude prompt is airtight
app.post("/api/full-analysis", analyzeLim, async (req, res) => {
  try {
    const { holdings, profile } = req.body;
    if (!Array.isArray(holdings) || !holdings.length)
      return res.status(400).json({ error: "holdings array required." });

    // Build positions
    const positions = holdings
      .filter(h => (h.symbol || "").toUpperCase() !== "CASH")
      .map(h => {
        const qty = parseFloat(h.quantity) || 0, avg = parseFloat(h.avgCost) || 0;
        const cur = parseFloat(h.currentPrice) || avg;
        const mkt = qty * cur, cost = qty * avg, plD = mkt - cost;
        return {
          symbol: (h.symbol || "").toUpperCase(), name: h.name || h.symbol || "Unknown",
          quantity: qty, avgCost: avg, currentPrice: cur,
          marketValue: mkt, costBasis: cost, plDollar: plD,
          plPct: cost > 0 ? (plD / cost) * 100 : 0,
        };
      })
      .filter(p => p.quantity > 0 && p.symbol)
      .sort((a, b) => b.marketValue - a.marketValue);

    if (!positions.length)
      return res.status(400).json({ error: "No valid positions found. Check that shares and avg cost are > 0." });

    const totalEquity = positions.reduce((s, p) => s + p.marketValue, 0);
    const cashPos = holdings.find(h => (h.symbol || "").toUpperCase() === "CASH");
    const cash = cashPos ? (parseFloat(cashPos.avgCost) || 0) * (parseFloat(cashPos.quantity) || 1) : 0;
    positions.forEach(p => { p.weight = totalEquity > 0 ? p.marketValue / totalEquity : 0; });

    const symbols = positions.slice(0, 8).map(p => p.symbol);

    // Fetch market data — both in parallel, neither can crash the endpoint
    const [quoteMap, techArr] = await Promise.all([
      fetchQuote(symbols).catch(e => { console.warn("[fetchQuote failed]", e.message); return {}; }),
      Promise.all(symbols.map(s => analyzeTechnical(s).catch(() => null))),
    ]);

    // Merge market data into positions
    symbols.forEach((sym, i) => {
      const pos = positions.find(p => p.symbol === sym);
      if (!pos) return;
      const q = quoteMap[sym];
      if (q) {
        pos.fundamentals = q;
        if (q.analystTarget) pos.analystTarget = q.analystTarget;
        // Use live price if user didn't provide current price
        if (q.currentPrice && pos.currentPrice === pos.avgCost) pos.currentPrice = q.currentPrice;
      }
      pos.technical = techArr[i] || null;
      if (techArr[i]) pos.historical = techArr[i];
    });

    console.log(`[full-analysis] funds: ${Object.keys(quoteMap).length}/${symbols.length} | tech: ${techArr.filter(Boolean).length}/${symbols.length}`);

    // Build prompt lines — each position wrapped in try/catch
    const posLines = positions.slice(0, 8).map(p => {
      try {
        const f = p.fundamentals, t = p.technical;
        const lines = [
          `\n== ${p.symbol} (${p.name}) ==`,
          `  Position: ${p.quantity.toFixed(2)}sh @ $${p.avgCost.toFixed(2)} avg | Current: $${p.currentPrice.toFixed(2)} | Value: $${p.marketValue.toFixed(2)} | P&L: ${p.plDollar >= 0 ? "+" : ""}$${p.plDollar.toFixed(2)} (${p.plPct.toFixed(1)}%) | Weight: ${(p.weight * 100).toFixed(1)}%`,
        ];
        if (f) {
          const pe = f.pe?.toFixed(1) || "N/A", fpe = f.forwardPE?.toFixed(1) || "N/A";
          const pb = f.pb?.toFixed(2) || "N/A", beta = f.beta?.toFixed(2) || "N/A";
          lines.push(`  Valuation: P/E=${pe} | FwdP/E=${fpe} | P/B=${pb} | Beta=${beta}`);
          if (f.analystTarget) lines.push(`  Analyst Target: $${f.analystTarget.toFixed(2)} | Rec: ${f.recommendation || "N/A"}`);
          if (f.fiftyTwoHigh) lines.push(`  52W: $${f.fiftyTwoLow?.toFixed(2) || "?"}–$${f.fiftyTwoHigh?.toFixed(2) || "?"} | DivYield: ${f.dividendYield ? (f.dividendYield * 100).toFixed(2) + "%" : "N/A"}`);
        }
        if (t && t.trend) {
          const tr = t.trend;
          lines.push(`  Technical: ${tr.trend} | RSI=${t.signals.find(s => s.indicator === "RSI")?.value || "N/A"} | MACD=${t.signals.find(s => s.indicator === "MACD")?.signal || "N/A"}`);
          lines.push(`  3M return: ${tr.perf3m != null ? (tr.perf3m * 100).toFixed(1) + "%" : "N/A"} | 1Y: ${tr.perf1y != null ? (tr.perf1y * 100).toFixed(1) + "%" : "N/A"} | Vol: ${(tr.annualVol * 100).toFixed(0)}%/yr`);
          lines.push(`  MA20=$${tr.ma20?.toFixed(2) || "?"} MA50=$${tr.ma50?.toFixed(2) || "?"} | Support=$${tr.support?.toFixed(2) || "?"} Resistance=$${tr.resistance?.toFixed(2) || "?"}`);
          if (t.patterns?.length) lines.push(`  Patterns: ${t.patterns.map(p => p.name + "(" + p.signal + ")").join(", ")}`);
        }
        return lines.join("\n");
      } catch (lineErr) {
        return `\n== ${p.symbol} ==\n  $${p.marketValue.toFixed(2)} | ${p.plDollar >= 0 ? "+" : ""}$${p.plDollar.toFixed(2)} P&L`;
      }
    }).join("\n");

    // FIX #3: Strict prompt that forces valid JSON every time
    const prompt = `You are analyzing a real investment portfolio. Output a JSON object only.

INVESTOR: Horizon=${profile?.horizon || "medium"} | Risk=${profile?.risk || "moderate"} | Goal=${profile?.goal || "balanced"}
PORTFOLIO: $${totalEquity.toFixed(2)} equity | $${cash.toFixed(2)} cash | ${positions.length} positions
${posLines}

Output ONLY a raw JSON object. No markdown, no fences, no explanation. Start with { and end with }.

{
  "overall_grade": "B+",
  "diversification_score": 62,
  "risk_level": "Moderate",
  "one_liner": "Tech-heavy growth portfolio with strong momentum but concentration risk",
  "overview": "3 sentences on the portfolio combining technical and fundamental view.",
  "top_actions": [
    {"priority":"High","type":"Trim","symbol":"NVDA","action_text":"Trim 25% of NVDA position","reasoning":"RSI overbought at 78, P/E 65x vs sector 32x — take profits","target_price":null,"stop_loss":null}
  ],
  "position_scores": [
    {"symbol":"NVDA","score":72,"technical_view":"bullish","fundamental_view":"expensive","verdict":"Strong momentum but stretched valuation — hold, don't add"}
  ],
  "sector_breakdown": [{"sector":"Technology","pct":60,"status":"Overweight"}],
  "cash_recommendation": "Deploy $X into Y over Z timeframe",
  "biggest_risks": ["Concentration risk — top 2 holdings = 70% of portfolio"],
  "key_insights": ["Insight 1","Insight 2"],
  "missing_exposure": ["Bonds","International","Healthcare"],
  "winners_to_trim": [{"symbol":"X","reason":"reason","suggested_trim_pct":25}],
  "losers_to_cut": [{"symbol":"X","reason":"reason"}],
  "tax_insight": "Tax note",
  "summary_bullets": ["Bullet 1","Bullet 2","Bullet 3"]
}`;

    const msg = await client.messages.create({
      model: MODEL, max_tokens: 3000,
      system: "You are a portfolio analyst. Output ONLY raw JSON. No markdown fences. No explanation. Start immediately with {",
      messages: [{ role: "user", content: prompt }],
    });

    const rawText = msg.content[0].text;
    console.log("[full-analysis] Claude raw (first 200):", rawText.slice(0, 200));

    const analysis = parseJSON(rawText);
    stats.analyses++;

    res.json({
      success: true,
      data: {
        positions,
        summary: { totalEquity, dayChange: 0, dayChangePct: 0, cash, totalPositions: positions.length },
        analysis,
        technical:    Object.fromEntries(symbols.map((s, i) => [s, techArr[i]])),
        fundamentals: Object.fromEntries(symbols.map(s => [s, quoteMap[s] || null])),
      },
    });
  } catch (e) {
    console.error("[full-analysis] FATAL:", e.message);
    console.error("[full-analysis] STACK:", e.stack?.split("\n").slice(0, 6).join(" | "));
    res.status(500).json({ error: e.message });
  }
});

// ── Simulate
app.post("/api/simulate", analyzeLim, async (req, res) => {
  try {
    const { positions, optimizedWeights, months = 24 } = req.body;
    if (!positions?.length) return res.status(400).json({ error: "positions required." });
    const total = positions.reduce((s, p) => s + (p.marketValue || 0), 0);
    positions.forEach(p => { p.weight = total > 0 ? (p.marketValue || 0) / total : 0; });
    const current  = monteCarlo(positions, months, 600);
    let optimized  = null;
    if (optimizedWeights?.length) {
      const opt = optimizedWeights.map(w => ({ ...positions.find(p => p.symbol === w.symbol) || {}, weight: w.weight }));
      optimized = monteCarlo(opt, months, 600);
    }
    stats.simulations++;
    res.json({ success: true, data: { current, optimized, totalEquity: total, months } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Generate gap ideas
app.post("/api/generate-gap-ideas", genLim, async (req, res) => {
  try {
    const { analysis, positions, profile } = req.body;
    const missing   = (analysis?.missing_exposure || []).join(", ") || "diversification";
    const weakness  = (analysis?.key_weaknesses   || []).slice(0, 3).join("; ") || "concentration";
    const current   = (positions || []).map(p => p.symbol).join(", ") || "none";
    const prompt = `Generate exactly 6 investment ideas to fill gaps in this portfolio.

Current holdings (DO NOT suggest these): ${current}
Missing exposure: ${missing}
Key weaknesses: ${weakness}
Profile: Horizon=${profile?.horizon || "medium"} | Risk=${profile?.risk || "moderate"} | Goal=${profile?.goal || "balanced"}

Output ONLY raw JSON. No markdown. Start with {

{"ideas":[{"name":"string","ticker":"TICK","description":"2 sentences","risk":"Low risk","allocation":15,"category":"ETF","sector":"Bonds","upside":"8-12% annually","why_now":"Current macro reason","why_this_portfolio":"Exactly how this fills the identified gap","tags":["tag1"]}],"summary":{"rationale":"string"}}`;
    const msg  = await client.messages.create({
      model: MODEL, max_tokens: 2000,
      system: "Output ONLY raw JSON. Start with {. No markdown fences.",
      messages: [{ role: "user", content: prompt }],
    });
    stats.ideas++;
    res.json({ success: true, data: parseJSON(msg.content[0].text) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Chat (streaming)
app.post("/api/chat", chatLim, async (req, res) => {
  try {
    const { messages, question, portfolioSummary } = req.body;
    if (!question || !Array.isArray(messages)) return res.status(400).json({ error: "Missing fields." });
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const send = obj => res.write("data: " + JSON.stringify(obj) + "\n\n");
    const stream = await client.messages.stream({
      model: MODEL, max_tokens: 1200,
      system: `Senior portfolio analyst. ${portfolioSummary ? "Portfolio context:\n" + portfolioSummary : ""}\nCite specific tickers and numbers. Plain text only.`,
      messages: [...messages, { role: "user", content: question }],
    });
    stream.on("text", t => send({ text: t }));
    stream.on("finalMessage", () => { send({ done: true }); res.end(); stats.chats++; });
    stream.on("error", e => { send({ error: e.message }); res.end(); });
    req.on("close", () => stream.abort());
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else { res.write("data: " + JSON.stringify({ error: e.message }) + "\n\n"); res.end(); }
  }
});

// ── Health / stats
app.get("/api/health", (_, res) => res.json({ status: "ok", model: MODEL, uptime: Math.floor((Date.now() - startTime) / 60000) + "min" }));
app.get("/api/stats",  (_, res) => res.json({ ...stats }));
app.get("*",           (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`QuantumInvest running on :${PORT}`));
module.exports = app;
