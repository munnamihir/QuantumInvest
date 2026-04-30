require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY environment variable is not set.');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Security & middleware ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'"],   // allows <script> blocks, no external scripts
      scriptSrcAttr: ["'none'"],                       // blocks onclick="..." — use addEventListener instead
      styleSrc:      ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:       ["'self'", "https://fonts.gstatic.com"],
      connectSrc:    ["'self'"],                       // fetch('/api/...') same-origin only
      imgSrc:        ["'self'", "data:"],
      objectSrc:     ["'none'"],
      baseUri:       ["'self'"],
    }
  }
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiting ──────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' }
});

const generateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: { error: 'Generating too fast. Please wait a moment.' }
});

app.use('/api/', apiLimiter);

// ── System prompt ──────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a senior investment research analyst with 20+ years of experience across global equities, ETFs, bonds, real estate, commodities, and alternative assets. You work at a top-tier investment bank and provide thorough, research-backed, personalized investment ideas tailored to specific investor profiles.

Your analysis is grounded in:
- Fundamental analysis (P/E, EPS growth, FCF, debt levels)
- Macroeconomic context and sector trends
- Risk-adjusted return optimization
- Portfolio diversification principles
- Regulatory and geopolitical considerations

You always align recommendations to the investor's specific risk tolerance, time horizon, and stated goals. You are honest about risks and never overpromise returns.`;

// ── Helpers ────────────────────────────────────────────────────────────────────
const HORIZON_MAP = {
  short:  'short-term (0–1 year)',
  medium: 'medium-term (1–5 years)',
  long:   'long-term (5+ years)'
};

const RISK_MAP = {
  conservative: 'conservative (capital preservation, low volatility)',
  moderate:     'moderate (balanced growth, some volatility acceptable)',
  aggressive:   'aggressive (maximize returns, high volatility acceptable)'
};

const STYLE_MAP = {
  growth:   'growth investing (high-growth companies, higher P/E acceptable)',
  value:    'value investing (undervalued assets, margin of safety)',
  dividend: 'dividend/income investing (regular cash flow, yield-focused)',
  index:    'index/passive investing (low-cost broad market exposure)',
  thematic: 'thematic/trend investing (specific macro or tech themes)'
};

function buildGeneratePrompt({ amount, horizon, risk, style, sectors, context }) {
  const sectorList = Array.isArray(sectors) && sectors.length
    ? sectors.join(', ')
    : 'any sector (no preference)';

  return `Generate personalized investment ideas for this investor profile:

- Investment amount: ${amount}
- Time horizon: ${HORIZON_MAP[horizon] || horizon}
- Risk tolerance: ${RISK_MAP[risk] || risk}
- Investment style: ${STYLE_MAP[style] || style}
- Sectors of interest: ${sectorList}
${context ? `- Additional context: ${context}` : ''}

Respond with ONLY a valid JSON object (no markdown fences, no extra text) with exactly these fields:

{
  "ideas": [   // exactly 6 investment ideas
    {
      "name": "string",          // company name, ETF name, or asset class
      "ticker": "string|null",   // stock/ETF ticker e.g. "AAPL", "VTI", or null
      "description": "string",   // 2 concise sentences: what it is + why it fits this specific profile
      "risk": "string",          // EXACTLY one of: "Low risk", "Moderate risk", "High risk"
      "allocation": number,      // suggested % allocation (integer, all 6 must sum to exactly 100)
      "category": "string",      // EXACTLY one of: "Stocks", "ETF", "Bonds", "Real Estate", "Crypto", "Commodities", "Cash"
      "upside": "string",        // brief upside case e.g. "20-30% over 3Y if earnings accelerate"
      "tags": ["string"]         // 2-3 short descriptive tags
    }
  ],
  "summary": {
    "overall_risk": "string",    // "Conservative", "Moderate", or "Aggressive"
    "expected_return": "string", // e.g. "8-12% annually" or "6-10% over 3Y"
    "diversification": "string", // brief note on diversification
    "top_pick": "string"         // name of the single strongest conviction idea
  },
  "analysis": "string"           // 4 paragraphs: (1) overall strategy rationale, (2) why these picks suit the profile, (3) key risks and mitigation, (4) one concrete actionable next step
}

Return ONLY the raw JSON. No explanation, no code fences, no preamble.`;
}

// ── POST /api/generate ─────────────────────────────────────────────────────────
app.post('/api/generate', generateLimiter, async (req, res) => {
  try {
    const { amount, horizon, risk, style, sectors, context } = req.body;

    if (!amount || !horizon || !risk || !style) {
      return res.status(400).json({ error: 'Missing required fields: amount, horizon, risk, style.' });
    }
    if (!['short','medium','long'].includes(horizon)) {
      return res.status(400).json({ error: 'Invalid horizon value.' });
    }
    if (!['conservative','moderate','aggressive'].includes(risk)) {
      return res.status(400).json({ error: 'Invalid risk value.' });
    }

    const prompt = buildGeneratePrompt({ amount, horizon, risk, style, sectors, context });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      system: SYSTEM_PROMPT + '\n\nYou respond ONLY with the exact JSON structure requested. No markdown fences, no extra text, no preamble.',
      messages: [{ role: 'user', content: prompt }]
    });

    let raw = message.content[0].text.trim();
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    const parsed = JSON.parse(raw);

    // Validate structure
    if (!parsed.ideas || !Array.isArray(parsed.ideas) || parsed.ideas.length === 0) {
      throw new Error('Invalid response structure from AI.');
    }

    res.json({ success: true, data: parsed });

  } catch (err) {
    console.error('[/api/generate]', err.message);
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: 'AI returned malformed data. Please try again.' });
    }
    res.status(500).json({ error: err.message || 'Failed to generate investment ideas.' });
  }
});

// ── POST /api/chat  (SSE streaming) ───────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, question, profileSummary } = req.body;

    if (!question || !messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing required fields: question, messages.' });
    }
    if (question.length > 1000) {
      return res.status(400).json({ error: 'Question too long.' });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering on Render
    res.flushHeaders();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const chatMessages = [
      ...messages,
      {
        role: 'user',
        content: question + '\n\nRespond in plain conversational text. Be concise, specific, and actionable. No JSON, no markdown headers.'
      }
    ];

    const context = profileSummary
      ? `\n\nInvestor context: ${profileSummary}`
      : '';

    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: SYSTEM_PROMPT + context + '\n\nAnswer follow-up questions about the investment ideas you generated. Be direct and concise. Plain text only.',
      messages: chatMessages
    });

    stream.on('text', (text) => send({ text }));
    stream.on('finalMessage', (msg) => {
      send({ done: true, usage: msg.usage });
      res.end();
    });
    stream.on('error', (err) => {
      send({ error: err.message });
      res.end();
    });

    req.on('close', () => stream.abort());

  } catch (err) {
    console.error('[/api/chat]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

// ── GET /api/health ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    model: 'claude-sonnet-4-20250514'
  });
});

// ── Catch-all → serve frontend ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Investment Agent running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
