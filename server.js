require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");
const axios     = require("axios");
const { v4: uuid } = require("uuid");
const path      = require("path");

const app   = express();
const PORT  = process.env.PORT || 3000;
const MODEL = "claude-sonnet-4-5";

if (!process.env.ANTHROPIC_API_KEY) { console.error("FATAL: ANTHROPIC_API_KEY not set"); process.exit(1); }
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Stats ─────────────────────────────────────────────────────────────────────
let stats = { generations:0, comparisons:0, analyzes:0, chats:0, portfolioScans:0 };
const startTime = Date.now();

// ── CSP / Security ────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'","'unsafe-inline'"],
      scriptSrcAttr: ["'none'"],
      styleSrc:      ["'self'","'unsafe-inline'","https://fonts.googleapis.com"],
      fontSrc:       ["'self'","https://fonts.gstatic.com"],
      connectSrc:    ["'self'"],
      imgSrc:        ["'self'","data:","https:"],
      objectSrc:     ["'none'"],
      baseUri:       ["'self'"],
    }
  }
}));
app.use(cors({ origin: process.env.FRONTEND_URL || "*", methods:["GET","POST"] }));
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Rate limiters ─────────────────────────────────────────────────────────────
const lim  = (max,win) => rateLimit({ windowMs:win*1000,max,standardHeaders:true,legacyHeaders:false,message:{error:"Too many requests."} });
app.use("/api/", lim(100, 15*60));
const genLim     = lim(5,  60);
const compareLim = lim(10, 60);
const analyzeLim = lim(10, 60);
const chatLim    = lim(30, 60);
const rhLim      = lim(8,  60);    // Robinhood — conservative to avoid lockouts

// ── Shared ────────────────────────────────────────────────────────────────────
const ANALYST = `You are a senior investment research analyst with 20+ years of experience across global equities, ETFs, bonds, real estate, commodities, and alternatives. You provide rigorous, research-backed analysis tailored to specific investor profiles. You always consider risk-adjusted returns and the investor's specific goals.`;

const HORIZON = { short:"short-term (0-1 yr)", medium:"medium-term (1-5 yrs)", long:"long-term (5+ yrs)" };
const RISK    = { conservative:"conservative (capital preservation)", moderate:"moderate (balanced growth)", aggressive:"aggressive (maximize returns)" };
const STYLE   = { growth:"growth investing", value:"value investing", dividend:"dividend/income investing", index:"index/passive", thematic:"thematic/trend" };

function parseJSON(raw) {
  return JSON.parse(raw.trim().replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/```\s*$/i,"").trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// ROBINHOOD INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────
const RH_BASE   = "https://api.robinhood.com";
const RH_CLIENT = "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS";

// Try multiple User-Agents — Robinhood rejects outdated version strings.
// We rotate through them on retry if the first gets a version error.
const RH_USER_AGENTS = [
  "python-requests/2.32.3",                                          // robin_stocks approach — widely accepted
  "Robinhood/8.198.0 (iPhone; iOS 17.5.1; Scale/3.00)",             // recent iOS app version
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90",
];

const rhHeaders = (token, uaIndex = 0) => ({
  "Content-Type":              "application/json",
  "Accept":                    "application/json",
  "Accept-Language":           "en-US,en;q=0.9",
  "Accept-Encoding":           "gzip, deflate, br",
  "User-Agent":                RH_USER_AGENTS[uaIndex % RH_USER_AGENTS.length],
  "X-Robinhood-API-Version":   "1.431.4",
  "X-TimeZone-Id":             "America/New_York",
  ...(token ? { "Authorization": `Bearer ${token}` } : {})
});

// Detect Robinhood's "please update" response
function isVersionError(data) {
  const msg = (data?.detail || data?.message || "").toLowerCase();
  return msg.includes("update") || msg.includes("version") || msg.includes("upgrade");
}

async function rhPost(path, body, extraHeaders = {}, uaIndex = 0) {
  try {
    const r = await axios.post(RH_BASE + path, body, {
      headers: { ...rhHeaders(null, uaIndex), ...extraHeaders },
      timeout: 14000,
      validateStatus: () => true
    });
    return { status: r.status, data: r.data };
  } catch(e) {
    return { status: 0, data: { detail: e.message } };
  }
}

async function rhGet(url, token) {
  const fullUrl = url.startsWith("http") ? url : RH_BASE + url;
  try {
    const r = await axios.get(fullUrl, {
      headers: rhHeaders(token),
      timeout: 10000,
      validateStatus: () => true
    });
    return { status: r.status, data: r.data };
  } catch(e) {
    return { status: 0, data: {} };
  }
}

async function paginateAll(firstUrl, token, max = 200) {
  const results = [];
  let url = firstUrl;
  while (url && results.length < max) {
    const { data } = await rhGet(url, token);
    results.push(...(data.results || []));
    url = data.next || null;
  }
  return results;
}

// ── POST /api/robinhood/login ─────────────────────────────────────────────────
app.post("/api/robinhood/login", rhLim, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });

  const deviceToken = uuid();

  let lastData = {};
  // Try each User-Agent in sequence until one works
  for (let uaIdx = 0; uaIdx < RH_USER_AGENTS.length; uaIdx++) {
    const { status, data } = await rhPost("/oauth2/token/", {
      username: email, password,
      grant_type: "password",
      client_id: RH_CLIENT,
      expires_in: 86400,
      scope: "internal",
      device_token: deviceToken,
      challenge_type: "sms"
    }, {}, uaIdx);

    lastData = data;

    if (status === 200 && data.access_token) {
      return res.json({ success: true, token: data.access_token, deviceToken });
    }
    if (data.mfa_required) {
      return res.json({ success: false, mfa_required: true, deviceToken, email, password });
    }
    if (data.challenge) {
      return res.json({ success: false, challenge_required: true, challengeId: data.challenge.id, deviceToken, email, password });
    }
    // If not a version error, stop retrying — wrong credentials etc.
    if (!isVersionError(data)) break;
  }

  if (isVersionError(lastData)) {
    return res.status(503).json({
      error: "Robinhood API is blocking automated access right now.",
      hint: "Use Manual Portfolio Entry below to enter your holdings directly — it works the same way for analysis."
    });
  }
  const msg = lastData.detail || (Array.isArray(lastData.non_field_errors) ? lastData.non_field_errors[0] : null) || "Login failed. Check your email and password.";
  res.status(401).json({ error: msg });
});

// ── POST /api/robinhood/verify ────────────────────────────────────────────────
app.post("/api/robinhood/verify", rhLim, async (req, res) => {
  const { email, password, code, deviceToken, challengeId } = req.body;
  if (!code || !deviceToken) return res.status(400).json({ error: "Code and device token required." });

  if (challengeId) {
    // Respond to Robinhood challenge (SMS / email code)
    await rhPost(`/challenge/${challengeId}/respond/`, { response: code });

    const { status, data } = await rhPost("/oauth2/token/", {
      username: email, password,
      grant_type: "password",
      client_id: RH_CLIENT,
      expires_in: 86400,
      scope: "internal",
      device_token: deviceToken,
    }, { "X-ROBINHOOD-CHALLENGE-RESPONSE-ID": challengeId });

    if (status === 200 && data.access_token) return res.json({ success: true, token: data.access_token });
    return res.status(401).json({ error: data.detail || "Challenge verification failed." });
  }

  // MFA TOTP / SMS code
  const { status, data } = await rhPost("/oauth2/token/", {
    username: email, password,
    grant_type: "password",
    client_id: RH_CLIENT,
    expires_in: 86400,
    scope: "internal",
    device_token: deviceToken,
    mfa_code: code,
  });

  if (status === 200 && data.access_token) return res.json({ success: true, token: data.access_token });
  res.status(401).json({ error: data.detail || "MFA verification failed. Wrong code?" });
});

// ── POST /api/robinhood/portfolio ─────────────────────────────────────────────
app.post("/api/robinhood/portfolio", rhLim, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token required." });

  // Parallel fetch of positions, account, portfolios
  const [posResp, acctResp, portResp] = await Promise.all([
    rhGet("/positions/?nonzero=true&default_to_account=robinhood", token),
    rhGet("/accounts/", token),
    rhGet("/portfolios/", token),
  ]);

  if (posResp.status === 401 || acctResp.status === 401) {
    return res.status(401).json({ error: "Session expired. Please reconnect your account." });
  }

  // Paginate positions
  const rawPositions = [...(posResp.data.results || [])];
  if (posResp.data.next) {
    const more = await paginateAll(posResp.data.next, token, 190);
    rawPositions.push(...more);
  }

  // Fetch all instrument details in parallel (batched to avoid overwhelming)
  const instUrls = [...new Set(rawPositions.map(p => p.instrument).filter(Boolean))];
  const instruments = {};
  const instChunks = [];
  for (let i = 0; i < instUrls.length; i += 10) instChunks.push(instUrls.slice(i, i+10));
  for (const chunk of instChunks) {
    await Promise.all(chunk.map(async (url) => {
      const { data } = await rhGet(url, token);
      if (data.symbol) instruments[url] = data;
    }));
  }

  // Fetch quotes by symbol
  const symbols = [...new Set(Object.values(instruments).map(i => i.symbol).filter(Boolean))];
  const quotes = {};
  for (let i = 0; i < symbols.length; i += 75) {
    const batch = symbols.slice(i, i+75);
    const { data } = await rhGet("/quotes/?symbols=" + batch.join(","), token);
    (data.results || []).forEach(q => { if (q && q.symbol) quotes[q.symbol] = q; });
  }

  // Enrich positions
  const positions = rawPositions.map(pos => {
    const inst = instruments[pos.instrument] || {};
    const quote = quotes[inst.symbol] || {};
    const qty  = parseFloat(pos.quantity) || 0;
    const avg  = parseFloat(pos.average_buy_price) || 0;
    const cur  = parseFloat(quote.last_trade_price || quote.last_extended_hours_trade_price || avg);
    const mktVal  = qty * cur;
    const cost    = qty * avg;
    const plDollar = mktVal - cost;
    const plPct   = cost > 0 ? (plDollar / cost) * 100 : 0;
    return {
      symbol:      inst.symbol     || "N/A",
      name:        inst.simple_name || inst.name || inst.symbol || "Unknown",
      type:        inst.type        || "stock",
      quantity:    qty,
      avgCost:     avg,
      currentPrice: cur,
      marketValue:  mktVal,
      costBasis:    cost,
      plDollar,
      plPct,
    };
  }).filter(p => p.quantity > 0 && p.symbol !== "N/A")
    .sort((a,b) => b.marketValue - a.marketValue);

  // Summary
  const account   = acctResp.data?.results?.[0] || {};
  const portfolio = portResp.data?.results?.[0] || {};
  const totalEquity  = parseFloat(portfolio.equity)               || positions.reduce((s,p) => s+p.marketValue, 0);
  const prevClose    = parseFloat(portfolio.equity_previous_close) || totalEquity;
  const dayChange    = totalEquity - prevClose;
  const dayChangePct = prevClose > 0 ? (dayChange / prevClose) * 100 : 0;
  const cash         = parseFloat(account.buying_power || account.cash || account.portfolio_cash || "0");

  stats.portfolioScans++;
  res.json({
    success: true,
    data: {
      positions,
      summary: { totalEquity, dayChange, dayChangePct, cash, totalPositions: positions.length }
    }
  });
});

// ── POST /api/portfolio-analyze ───────────────────────────────────────────────
app.post("/api/portfolio-analyze", analyzeLim, async (req, res) => {
  const { positions, summary, profile } = req.body;
  if (!positions?.length) return res.status(400).json({ error: "Portfolio positions required." });

  const positionLines = positions.slice(0, 50).map(p =>
    `${p.symbol} (${p.name}): ${p.quantity} shares, avg cost $${(p.avgCost||0).toFixed(2)}, ` +
    `current $${(p.currentPrice||0).toFixed(2)}, value $${(p.marketValue||0).toFixed(2)}, ` +
    `P&L: ${p.plDollar>=0?"+":""}$${(p.plDollar||0).toFixed(2)} (${(p.plPct||0).toFixed(1)}%)`
  ).join("\n");

  const prompt = `Analyze this real Robinhood portfolio and give specific, actionable recommendations.

PORTFOLIO SUMMARY:
- Total Equity: $${(summary.totalEquity||0).toFixed(2)}
- Cash / Buying Power: $${(summary.cash||0).toFixed(2)}
- Today\'s Change: ${summary.dayChange>=0?"+":""}$${(summary.dayChange||0).toFixed(2)} (${(summary.dayChangePct||0).toFixed(2)}%)
- Total Positions: ${summary.totalPositions}

CURRENT HOLDINGS:
${positionLines}

INVESTOR PROFILE: ${JSON.stringify(profile||{})}

Respond ONLY with raw JSON (no fences):
{
  "diversification_score": number (0-100),
  "risk_level": "Low"|"Moderate"|"High"|"Very High",
  "overall_grade": "A+"|"A"|"B+"|"B"|"C+"|"C"|"D",
  "one_liner": "string (sharp 12-word portfolio verdict)",
  "overview": "string (3-sentence comprehensive assessment)",
  "key_insights": ["string","string","string","string"],
  "top_actions": [
    {
      "priority": "High"|"Medium"|"Low",
      "type": "Buy"|"Sell"|"Trim"|"Hold"|"Rebalance"|"Add",
      "symbol": "string or null",
      "action_text": "string (verb + what + how much, e.g. Sell 30% of TSLA)",
      "reasoning": "string (specific, 2 sentences)"
    }
  ],
  "cash_recommendation": "string (specific: what to do with the $X buying power)",
  "biggest_risks": ["string","string","string"],
  "sector_breakdown": [
    {"sector":"string","pct":number,"status":"Overweight"|"Good"|"Underweight"}
  ],
  "winners_to_trim": [{"symbol":"string","reason":"string"}],
  "losers_to_cut": [{"symbol":"string","reason":"string"}],
  "missing_exposure": ["string","string"],
  "tax_insight": "string",
  "summary_bullets": ["string","string","string","string","string"]
}`;

  try {
    const msg = await client.messages.create({
      model: MODEL, max_tokens: 2500,
      system: ANALYST + "\nRespond ONLY with raw JSON.",
      messages: [{ role:"user", content: prompt }]
    });
    const data = parseJSON(msg.content[0].text);
    res.json({ success: true, data });
  } catch(e) {
    console.error("[portfolio-analyze]", e.message);
    res.status(500).json({ error: e instanceof SyntaxError ? "AI returned malformed data." : e.message });
  }
});

// ── POST /api/portfolio/manual ─────────────────────────────────────────────────
// Accepts manually entered holdings and runs the same AI analysis
app.post("/api/portfolio/manual", analyzeLim, async (req, res) => {
  const { holdings, profile } = req.body;
  // holdings: [{symbol, name, quantity, avgCost, currentPrice}]
  if (!Array.isArray(holdings) || !holdings.length) {
    return res.status(400).json({ error: "holdings array required." });
  }

  // Enrich each holding
  const positions = holdings.map(h => {
    const qty  = parseFloat(h.quantity)     || 0;
    const avg  = parseFloat(h.avgCost)      || 0;
    const cur  = parseFloat(h.currentPrice) || avg;
    const mkt  = qty * cur;
    const cost = qty * avg;
    const plD  = mkt - cost;
    const plP  = cost > 0 ? (plD/cost)*100 : 0;
    return {
      symbol:       h.symbol?.toUpperCase() || "N/A",
      name:         h.name || h.symbol || "Unknown",
      type:         "stock",
      quantity:     qty,
      avgCost:      avg,
      currentPrice: cur,
      marketValue:  mkt,
      costBasis:    cost,
      plDollar:     plD,
      plPct:        plP,
    };
  }).filter(p => p.quantity > 0 && p.symbol !== "N/A")
    .sort((a,b) => b.marketValue - a.marketValue);

  const totalEquity = positions.reduce((s,p) => s + p.marketValue, 0);
  const cash = parseFloat(holdings.find(h => h.symbol?.toUpperCase()==="CASH")?.marketValue || 0);

  res.json({
    success: true,
    data: {
      positions,
      summary: {
        totalEquity,
        dayChange: 0,
        dayChangePct: 0,
        cash,
        totalPositions: positions.length
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EXISTING ENDPOINTS (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/stats", (_req, res) => res.json({ ...stats, uptimeHours: Math.floor((Date.now()-startTime)/3600000) }));

app.post("/api/generate", genLim, async (req, res) => {
  const { amount, horizon, risk, style, sectors, context, portfolioContext } = req.body;
  if (!amount||!horizon||!risk||!style) return res.status(400).json({ error:"Missing required fields." });

  const sectorList = Array.isArray(sectors)&&sectors.length ? sectors.join(", ") : "any sector";
  const portContext = portfolioContext
    ? `\n\nIMPORTANT - USER\'S CURRENT PORTFOLIO (avoid overlap, fill gaps):\n${portfolioContext}`
    : "";

  const prompt = `Generate personalized investment ideas for this investor:
- Amount: ${amount}
- Horizon: ${HORIZON[horizon]||horizon}
- Risk: ${RISK[risk]||risk}
- Style: ${STYLE[style]||style}
- Sectors: ${sectorList}
${context ? "- Context: "+context : ""}${portContext}

Respond ONLY with raw JSON (no fences):
{
  "ideas": [
    {
      "name":"string","ticker":"string|null","description":"string (2 sentences: what + why it fits)",
      "risk":"Low risk"|"Moderate risk"|"High risk",
      "allocation":number (all 6 sum to 100),"category":"Stocks"|"ETF"|"Bonds"|"Real Estate"|"Crypto"|"Commodities"|"Cash",
      "sector":"string","upside":"string","volatility":"Low"|"Medium"|"High",
      "why_now":"string (one-sentence current opportunity)","tags":["string"]
    }
  ],
  "summary":{"overall_risk":"Conservative"|"Moderate"|"Aggressive","expected_return":"string","diversification":"string","top_pick":"string"},
  "analysis":"string (4 paragraphs)"
}`;

  try {
    const msg = await client.messages.create({ model:MODEL, max_tokens:2500, system:ANALYST+"\nRespond ONLY with raw JSON.", messages:[{role:"user",content:prompt}] });
    const data = parseJSON(msg.content[0].text);
    if (!data.ideas?.length) throw new Error("Invalid AI response.");
    stats.generations++;
    res.json({ success:true, data });
  } catch(e) {
    console.error("[generate]", e.message);
    res.status(500).json({ error: e instanceof SyntaxError ? "AI returned malformed data." : e.message });
  }
});

app.post("/api/chat", chatLim, async (req, res) => {
  const { messages, question, profileSummary } = req.body;
  if (!question||!Array.isArray(messages)) return res.status(400).json({ error:"Missing fields." });
  if (question.length > 1200) return res.status(400).json({ error:"Question too long." });

  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.setHeader("X-Accel-Buffering","no");
  res.flushHeaders();

  const send = obj => res.write("data: "+JSON.stringify(obj)+"\n\n");
  const history = [...messages, { role:"user", content: question+"\n\nBe direct and concise. Plain text only." }];

  try {
    const stream = await client.messages.stream({
      model:MODEL, max_tokens:1000,
      system: ANALYST + (profileSummary?"\n\nContext: "+profileSummary:"") + "\n\nAnswer concisely. Plain text only.",
      messages: history
    });
    stream.on("text", t => send({text:t}));
    stream.on("finalMessage", () => { send({done:true}); res.end(); stats.chats++; });
    stream.on("error", e => { send({error:e.message}); res.end(); });
    req.on("close", () => stream.abort());
  } catch(e) {
    if (!res.headersSent) res.status(500).json({error:e.message});
    else { res.write("data: "+JSON.stringify({error:e.message})+"\n\n"); res.end(); }
  }
});

app.post("/api/compare", compareLim, async (req, res) => {
  const { idea1, idea2, profile } = req.body;
  if (!idea1?.name||!idea2?.name) return res.status(400).json({ error:"Both ideas required." });

  const prompt = `Compare these two investments for: ${JSON.stringify(profile||{})}
A: ${JSON.stringify(idea1)}
B: ${JSON.stringify(idea2)}

Respond ONLY with raw JSON:
{"winner":"A"|"B"|"tie","verdict":"string","reasoning":"string",
"metrics":[{"metric":"string","A":"string","B":"string","winner":"A"|"B"|"tie"}],
"A_pros":["string","string","string"],"A_cons":["string","string"],
"B_pros":["string","string","string"],"B_cons":["string","string"],
"best_for_A":"string","best_for_B":"string",
"scenarios":[{"name":"string","pick":"A"|"B","reason":"string"}]}`;

  try {
    const msg = await client.messages.create({ model:MODEL, max_tokens:1800, system:ANALYST+"\nRespond ONLY with raw JSON.", messages:[{role:"user",content:prompt}] });
    const data = parseJSON(msg.content[0].text);
    stats.comparisons++;
    res.json({ success:true, data });
  } catch(e) {
    res.status(500).json({ error: e instanceof SyntaxError?"AI returned malformed data.":e.message });
  }
});

app.post("/api/analyze", analyzeLim, async (req, res) => {
  const { idea, profile } = req.body;
  if (!idea?.name) return res.status(400).json({ error:"Idea required." });

  const prompt = `Deep-dive analysis for profile: ${JSON.stringify(profile||{})}
Investment: ${JSON.stringify(idea)}

Respond ONLY with raw JSON:
{"score":number,"grade":"A+"|"A"|"B+"|"B"|"C+"|"C"|"D","sentiment":"bullish"|"neutral"|"cautious"|"bearish",
"one_liner":"string","overview":"string","pros":["string","string","string","string"],
"cons":["string","string","string"],"key_risks":["string","string","string"],
"entry_strategy":"string","exit_strategy":"string","position_size":"string","time_to_value":"string",
"due_diligence":["string","string","string","string"],"catalysts":["string","string"],
"watch_metrics":["string","string","string"],
"alternatives":[{"name":"string","ticker":"string|null","why":"string"},{"name":"string","ticker":"string|null","why":"string"}]}`;

  try {
    const msg = await client.messages.create({ model:MODEL, max_tokens:1800, system:ANALYST+"\nRespond ONLY with raw JSON.", messages:[{role:"user",content:prompt}] });
    const data = parseJSON(msg.content[0].text);
    stats.analyzes++;
    res.json({ success:true, data });
  } catch(e) {
    res.status(500).json({ error: e instanceof SyntaxError?"AI returned malformed data.":e.message });
  }
});

app.get("/api/health", (_req, res) => res.json({ status:"ok", model:MODEL, ...stats }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT, () => console.log(`InvestAI running on http://localhost:${PORT}`));
module.exports = app;
