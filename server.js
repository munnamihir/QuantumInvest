require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const MODEL = 'claude-sonnet-4-5';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY is not set.');
  process.exit(1);
}
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── In-memory stats (resets on restart — fine for Render free tier) ──────────
let stats = { generations: 0, comparisons: 0, analyzes: 0, chats: 0 };
const startTime = Date.now();

// ── Security ─────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'none'"],
      styleSrc:      ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:       ["'self'", "https://fonts.gstatic.com"],
      connectSrc:    ["'self'"],
      imgSrc:        ["'self'", "data:", "https:"],
      objectSrc:     ["'none'"],
      baseUri:       ["'self'"],
    }
  }
}));
app.use(cors({ origin: process.env.FRONTEND_URL || '*', methods: ['GET','POST'] }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiters ─────────────────────────────────────────────────────────────
const lim = (max, win) => rateLimit({ windowMs: win*1000, max, standardHeaders:true, legacyHeaders:false, message:{ error:'Too many requests. Try again shortly.' } });
app.use('/api/', lim(80, 15*60));   // 80/15min global
const genLim     = lim(5,  60);     // 5/min
const compareLim = lim(10, 60);     // 10/min
const analyzeLim = lim(10, 60);     // 10/min
const chatLim    = lim(30, 60);     // 30/min

// ── Shared prompts ────────────────────────────────────────────────────────────
const ANALYST = `You are a senior investment research analyst with 20+ years of experience across global equities, ETFs, bonds, real estate, commodities, and alternatives. You provide rigorous, research-backed analysis tailored to specific investor profiles. You always consider risk-adjusted returns, diversification, and the investor's specific goals. You are honest about risks and never overpromise.`;

const HORIZON = { short:'short-term (0–1 year)', medium:'medium-term (1–5 years)', long:'long-term (5+ years)' };
const RISK    = { conservative:'conservative (capital preservation, low volatility)', moderate:'moderate (balanced growth)', aggressive:'aggressive (maximize returns, high volatility OK)' };
const STYLE   = { growth:'growth investing', value:'value investing', dividend:'dividend/income investing', index:'index/passive investing', thematic:'thematic/trend investing' };

function parseJSON(raw) {
  raw = raw.trim().replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
  return JSON.parse(raw);
}

// ── GET /api/stats ────────────────────────────────────────────────────────────
app.get('/api/stats', (_req, res) => {
  res.json({ ...stats, uptimeHours: Math.floor((Date.now()-startTime)/3600000) });
});

// ── POST /api/generate ────────────────────────────────────────────────────────
app.post('/api/generate', genLim, async (req, res) => {
  const { amount, horizon, risk, style, sectors, context } = req.body;
  if (!amount || !horizon || !risk || !style) return res.status(400).json({ error:'Missing required fields.' });
  if (!HORIZON[horizon] || !RISK[risk]) return res.status(400).json({ error:'Invalid horizon or risk value.' });

  const sectorList = Array.isArray(sectors) && sectors.length ? sectors.join(', ') : 'any sector';

  const prompt = `Generate personalized investment ideas for this investor:
- Amount: ${amount}
- Horizon: ${HORIZON[horizon]}
- Risk: ${RISK[risk]}
- Style: ${STYLE[style]||style}
- Sectors: ${sectorList}
${context ? `- Context: ${context}` : ''}

Respond with ONLY raw JSON (no fences, no extra text):
{
  "ideas": [   // exactly 6 ideas
    {
      "name": "string",
      "ticker": "string|null",
      "description": "string (2 sentences: what it is + why it fits this profile)",
      "risk": "Low risk"|"Moderate risk"|"High risk",
      "allocation": number (integer, all 6 must sum to 100),
      "category": "Stocks"|"ETF"|"Bonds"|"Real Estate"|"Crypto"|"Commodities"|"Cash",
      "sector": "string (e.g. Technology, Healthcare, Energy...)",
      "upside": "string (e.g. '20-30% over 3Y if...')",
      "volatility": "Low"|"Medium"|"High",
      "why_now": "string (one sentence on current opportunity)",
      "tags": ["string"] (2-3 tags)
    }
  ],
  "summary": {
    "overall_risk": "Conservative"|"Moderate"|"Aggressive",
    "expected_return": "string (e.g. '8-12% annually')",
    "diversification": "string (brief note)",
    "top_pick": "string (name of strongest idea)"
  },
  "analysis": "string (4 paragraphs: strategy rationale, why these fit, key risks, actionable next step)"
}`;

  try {
    const msg = await client.messages.create({ model:MODEL, max_tokens:2500, system:ANALYST+'\nRespond ONLY with the exact JSON structure. No markdown, no explanation.', messages:[{role:'user',content:prompt}] });
    const data = parseJSON(msg.content[0].text);
    if (!data.ideas?.length) throw new Error('Invalid AI response structure.');
    stats.generations++;
    res.json({ success:true, data });
  } catch(e) {
    console.error('[generate]', e.message);
    res.status(500).json({ error: e instanceof SyntaxError ? 'AI returned malformed data. Try again.' : e.message });
  }
});

// ── POST /api/chat (SSE streaming) ───────────────────────────────────────────
app.post('/api/chat', chatLim, async (req, res) => {
  const { messages, question, profileSummary } = req.body;
  if (!question || !Array.isArray(messages)) return res.status(400).json({ error:'Missing fields.' });
  if (question.length > 1200) return res.status(400).json({ error:'Question too long.' });

  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const history = [...messages, { role:'user', content: question+'\n\nBe direct and concise. Plain text only — no JSON, no markdown headers.' }];

  try {
    const stream = await client.messages.stream({
      model:MODEL, max_tokens:1000,
      system: ANALYST + (profileSummary ? `\n\nInvestor context: ${profileSummary}` : '') + '\n\nAnswer follow-up questions about the investment ideas. Be direct, specific, and actionable. Plain text only.',
      messages: history
    });
    stream.on('text', t => send({ text:t }));
    stream.on('finalMessage', () => { send({ done:true }); res.end(); stats.chats++; });
    stream.on('error', e => { send({ error:e.message }); res.end(); });
    req.on('close', () => stream.abort());
  } catch(e) {
    console.error('[chat]', e.message);
    if (!res.headersSent) res.status(500).json({ error:e.message });
    else { res.write(`data: ${JSON.stringify({error:e.message})}\n\n`); res.end(); }
  }
});

// ── POST /api/compare ─────────────────────────────────────────────────────────
app.post('/api/compare', compareLim, async (req, res) => {
  const { idea1, idea2, profile } = req.body;
  if (!idea1?.name || !idea2?.name) return res.status(400).json({ error:'Both ideas required.' });

  const prompt = `Compare these two investment ideas for this investor profile: ${JSON.stringify(profile||{})}

IDEA A: ${JSON.stringify(idea1)}
IDEA B: ${JSON.stringify(idea2)}

Respond with ONLY raw JSON:
{
  "winner": "A"|"B"|"tie",
  "verdict": "string (one sentence clear recommendation)",
  "reasoning": "string (2-3 sentence explanation)",
  "metrics": [
    {"metric":"Risk Level","A":"string","B":"string","winner":"A"|"B"|"tie"},
    {"metric":"Expected Return","A":"string","B":"string","winner":"A"|"B"|"tie"},
    {"metric":"Liquidity","A":"string","B":"string","winner":"A"|"B"|"tie"},
    {"metric":"Income Potential","A":"string","B":"string","winner":"A"|"B"|"tie"},
    {"metric":"Growth Potential","A":"string","B":"string","winner":"A"|"B"|"tie"},
    {"metric":"Volatility","A":"string","B":"string","winner":"A"|"B"|"tie"},
    {"metric":"Diversification Value","A":"string","B":"string","winner":"A"|"B"|"tie"},
    {"metric":"Entry Complexity","A":"string","B":"string","winner":"A"|"B"|"tie"}
  ],
  "A_pros": ["string","string","string"],
  "A_cons": ["string","string"],
  "B_pros": ["string","string","string"],
  "B_cons": ["string","string"],
  "best_for_A": "string (type of investor A suits best)",
  "best_for_B": "string (type of investor B suits best)",
  "scenarios": [
    {"name":"Bull Market","pick":"A"|"B","reason":"string"},
    {"name":"Bear Market","pick":"A"|"B","reason":"string"},
    {"name":"High Inflation","pick":"A"|"B","reason":"string"},
    {"name":"Recession","pick":"A"|"B","reason":"string"}
  ]
}`;

  try {
    const msg = await client.messages.create({ model:MODEL, max_tokens:1800, system:ANALYST+'\nRespond ONLY with raw JSON.', messages:[{role:'user',content:prompt}] });
    const data = parseJSON(msg.content[0].text);
    stats.comparisons++;
    res.json({ success:true, data });
  } catch(e) {
    console.error('[compare]', e.message);
    res.status(500).json({ error: e instanceof SyntaxError ? 'AI returned malformed data. Try again.' : e.message });
  }
});

// ── POST /api/analyze ─────────────────────────────────────────────────────────
app.post('/api/analyze', analyzeLim, async (req, res) => {
  const { idea, profile } = req.body;
  if (!idea?.name) return res.status(400).json({ error:'Idea required.' });

  const prompt = `Provide a comprehensive deep-dive analysis of this investment for the given investor profile.

INVESTOR PROFILE: ${JSON.stringify(profile||{})}
INVESTMENT: ${JSON.stringify(idea)}

Respond with ONLY raw JSON:
{
  "score": number (0-100, fit score for this specific investor),
  "grade": "A+"|"A"|"B+"|"B"|"C+"|"C"|"D",
  "sentiment": "bullish"|"neutral"|"cautious"|"bearish",
  "one_liner": "string (sharp expert take in 15 words or less)",
  "overview": "string (3-sentence deep overview)",
  "pros": ["string","string","string","string"],
  "cons": ["string","string","string"],
  "key_risks": ["string","string","string"],
  "entry_strategy": "string (specific guidance on when/how to enter)",
  "exit_strategy": "string (target conditions or price to exit)",
  "position_size": "string (suggested % of portfolio with reasoning)",
  "time_to_value": "string (realistic timeline for returns)",
  "due_diligence": ["string","string","string","string"] (specific things to research before buying),
  "catalysts": ["string","string"] (upcoming events that could drive price),
  "watch_metrics": ["string","string","string"] (KPIs to monitor after buying),
  "alternatives": [
    {"name":"string","ticker":"string|null","reason":"string"},
    {"name":"string","ticker":"string|null","reason":"string"}
  ]
}`;

  try {
    const msg = await client.messages.create({ model:MODEL, max_tokens:1800, system:ANALYST+'\nRespond ONLY with raw JSON.', messages:[{role:'user',content:prompt}] });
    const data = parseJSON(msg.content[0].text);
    stats.analyzes++;
    res.json({ success:true, data });
  } catch(e) {
    console.error('[analyze]', e.message);
    res.status(500).json({ error: e instanceof SyntaxError ? 'AI returned malformed data. Try again.' : e.message });
  }
});

// ── GET /api/health ───────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status:'ok', model:MODEL, ...stats, uptimeHours: Math.floor((Date.now()-startTime)/3600000) }));

// ── Catch-all ─────────────────────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`InvestAI running on http://localhost:${PORT}`));
module.exports = app;
