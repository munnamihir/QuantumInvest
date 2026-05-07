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

const app   = express();
const PORT  = process.env.PORT || 3000;
const MODEL = "claude-sonnet-4-5";

// ── Env validation
if (!process.env.ANTHROPIC_API_KEY) { console.error("FATAL: ANTHROPIC_API_KEY not set"); process.exit(1); }
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Stats
let stats = { generations:0, comparisons:0, analyzes:0, chats:0, portfolioScans:0 };
const startTime = Date.now();

// ── AES-256-GCM encryption (production: replace with ML-KEM derived keys)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, "hex")
  : crypto.randomBytes(32);

function encryptData(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("hex"), data: encrypted.toString("hex"), tag: tag.toString("hex") };
}

function decryptData(payload) {
  const iv = Buffer.from(payload.iv, "hex");
  const tag = Buffer.from(payload.tag, "hex");
  const encrypted = Buffer.from(payload.data, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

// ── Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'","'unsafe-inline'"],
      scriptSrcAttr: ["'none'"], styleSrc: ["'self'","'unsafe-inline'","https://fonts.googleapis.com"],
      fontSrc: ["'self'","https://fonts.gstatic.com"], connectSrc: ["'self'"],
      imgSrc: ["'self'","data:","https:"], objectSrc: ["'none'"], baseUri: ["'self'"],
    }
  }
}));
app.use(cors({ origin: process.env.FRONTEND_URL || "*", methods: ["GET","POST"] }));
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Rate limiters
const lim = (max,win) => rateLimit({ windowMs:win*1000, max, standardHeaders:true, legacyHeaders:false, message:{error:"Too many requests."} });
app.use("/api/", lim(120, 15*60));
const genLim = lim(5,60), compareLim = lim(10,60), analyzeLim = lim(10,60), chatLim = lim(30,60), rhLim = lim(8,60);

// ── AI config
const ANALYST = `You are a senior investment research analyst with 20+ years of experience. You provide rigorous, research-backed analysis tailored to specific investor profiles. Always consider risk-adjusted returns.`;
const HORIZON = { short:"short-term (0-1 yr)", medium:"medium-term (1-5 yrs)", long:"long-term (5+ yrs)" };
const RISK    = { conservative:"conservative (capital preservation)", moderate:"moderate (balanced growth)", aggressive:"aggressive (maximize returns)" };
const STYLE   = { growth:"growth investing", value:"value investing", dividend:"dividend/income", index:"index/passive", thematic:"thematic/trend" };

// ── Robust JSON parser
function parseJSON(raw) {
  const cleaned = raw.trim().replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/```\s*$/i,"").trim();
  try { return JSON.parse(cleaned); } catch(e) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch(_){} }
    throw new Error("AI returned malformed response. Please try again.");
  }
}

// ── Robinhood
const RH_BASE = "https://api.robinhood.com";
const RH_CLIENT = "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS";
const RH_UAS = [
  "python-requests/2.32.3",
  "Robinhood/8.198.0 (iPhone; iOS 17.5.1; Scale/3.00)",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/21F90",
];
const rhH = (token, ui=0) => ({
  "Content-Type":"application/json","Accept":"application/json",
  "Accept-Language":"en-US,en;q=0.9","User-Agent":RH_UAS[ui%RH_UAS.length],
  "X-Robinhood-API-Version":"1.431.4","X-TimeZone-Id":"America/New_York",
  ...(token?{"Authorization":"Bearer "+token}:{})
});
const isVerErr = d => (d?.detail||d?.message||"").toLowerCase().includes("update")||(d?.detail||"").toLowerCase().includes("version");

async function rhPost(p, body, extra={}, ui=0) {
  try {
    const r = await axios.post(RH_BASE+p, body, {headers:{...rhH(null,ui),...extra},timeout:14000,validateStatus:()=>true});
    return {status:r.status,data:r.data};
  } catch(e) { return {status:0,data:{detail:e.message}}; }
}
async function rhGet(url, token) {
  const fu = url.startsWith("http")?url:RH_BASE+url;
  try {
    const r = await axios.get(fu, {headers:rhH(token),timeout:10000,validateStatus:()=>true});
    return {status:r.status,data:r.data};
  } catch(e) { return {status:0,data:{}}; }
}
async function paginateAll(firstUrl, token, max=200) {
  const res=[]; let url=firstUrl;
  while(url&&res.length<max){const{data}=await rhGet(url,token);res.push(...(data.results||[]));url=data.next||null;}
  return res;
}

// ── POST /api/robinhood/login
app.post("/api/robinhood/login", rhLim, async (req,res) => {
  const {email,password} = req.body;
  if(!email||!password) return res.status(400).json({error:"Email and password required."});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:"Invalid email."});
  const deviceToken = uuid();
  const attempts = [];

  for (let ui = 0; ui < RH_UAS.length; ui++) {
    const { status, data } = await rhPost("/oauth2/token/", {
      username: email, password,
      grant_type: "password", client_id: RH_CLIENT,
      expires_in: 86400, scope: "internal",
      device_token: deviceToken, challenge_type: "sms"
    }, {}, ui);

    // Log FULL response so Render logs show exactly what Robinhood returns
    console.log(`[RH Login] UA#${ui} status=${status} body=${JSON.stringify(data).slice(0, 300)}`);

    // Extract error message from any known field
    const extractMsg = (d) =>
      d?.detail ||
      (Array.isArray(d?.non_field_errors) ? d.non_field_errors[0] : null) ||
      d?.message ||
      d?.error ||
      (typeof d === "string" ? d : null) ||
      "";

    const detail = extractMsg(data);
    attempts.push({ ua: ui, status, detail, raw: data });

    if (status === 200 && data.access_token) {
      const enc = encryptData({ token: data.access_token, email, ts: Date.now() });
      return res.json({ success: true, encryptedSession: enc, deviceToken });
    }
    if (data.mfa_required) return res.json({ success: false, mfa_required: true, deviceToken });
    if (data.challenge) return res.json({ success: false, challenge_required: true, challengeId: data.challenge.id, deviceToken });
  }

  // Build best error message from all attempts
  const bestDetail = attempts.map(a => a.detail).find(d => d) || "";
  const bestStatus = attempts[0]?.status || 0;
  const low = bestDetail.toLowerCase();

  console.error("[RH Login] All UAs failed. Best detail:", bestDetail, "Best status:", bestStatus);

  // IP / cloud block — status 0 means network refused, or version error
  if (bestStatus === 0 || isVerErr({ detail: bestDetail }) || (!bestDetail && bestStatus >= 400)) {
    return res.status(503).json({
      error: "Robinhood is blocking connections from this server's IP address.",
      hint: "Cloud servers are commonly blocked by Robinhood. Use Manual Portfolio Entry below — enter your holdings directly. The AI analysis is exactly the same."
    });
  }
  if (low.includes("credential") || low.includes("password") || low.includes("invalid") || low.includes("unable to log in")) {
    return res.status(401).json({ error: "Wrong email or password. Check your Robinhood credentials and try again." });
  }
  if (low.includes("device") || low.includes("unrecognized") || low.includes("trusted")) {
    return res.status(401).json({ error: "Unrecognized device. Log into robinhood.com in a browser first, then retry here." });
  }
  if (low.includes("too many") || low.includes("throttl") || low.includes("limit") || bestStatus === 429) {
    return res.status(429).json({ error: "Too many login attempts. Wait 30 minutes then try again." });
  }
  if (low.includes("update") || low.includes("version") || low.includes("upgrade")) {
    return res.status(503).json({
      error: "Robinhood rejected the connection (version check failed).",
      hint: "Use Manual Portfolio Entry below instead."
    });
  }

  // Fallback — show raw Robinhood message if we have one, else show IP block message
  return res.status(bestStatus >= 400 ? bestStatus : 503).json({
    error: bestDetail || "Robinhood is blocking this server. Use Manual Entry below.",
    hint: bestDetail ? "" : "Cloud server IPs are commonly flagged by Robinhood. Manual entry works identically for AI analysis."
  });
});

// ── POST /api/robinhood/verify
app.post("/api/robinhood/verify", rhLim, async (req,res) => {
  const {email,password,code,deviceToken,challengeId}=req.body;
  if(!code||!deviceToken) return res.status(400).json({error:"Code and device token required."});
  if(challengeId){
    await rhPost("/challenge/"+challengeId+"/respond/",{response:code});
    const {status,data}=await rhPost("/oauth2/token/",{
      username:email,password,grant_type:"password",client_id:RH_CLIENT,
      expires_in:86400,scope:"internal",device_token:deviceToken
    },{"X-ROBINHOOD-CHALLENGE-RESPONSE-ID":challengeId});
    if(status===200&&data.access_token){
      const enc=encryptData({token:data.access_token,email,ts:Date.now()});
      return res.json({success:true,encryptedSession:enc});
    }
    return res.status(401).json({error:data.detail||"Challenge failed."});
  }
  const {status,data}=await rhPost("/oauth2/token/",{
    username:email,password,grant_type:"password",client_id:RH_CLIENT,
    expires_in:86400,scope:"internal",device_token:deviceToken,mfa_code:code
  });
  if(status===200&&data.access_token){
    const enc=encryptData({token:data.access_token,email,ts:Date.now()});
    return res.json({success:true,encryptedSession:enc});
  }
  res.status(401).json({error:data.detail||"MFA failed."});
});

// ── POST /api/robinhood/portfolio
app.post("/api/robinhood/portfolio", rhLim, async (req,res) => {
  const {encryptedSession}=req.body;
  if(!encryptedSession) return res.status(400).json({error:"Session required."});
  let sessionData;
  try { sessionData=decryptData(encryptedSession); } catch(e) { return res.status(401).json({error:"Invalid session. Please reconnect."}); }
  const {token,ts}=sessionData;
  if(Date.now()-ts>23*60*60*1000) return res.status(401).json({error:"Session expired. Please reconnect."});

  const [posR,acctR,portR]=await Promise.all([
    rhGet("/positions/?nonzero=true&default_to_account=robinhood",token),
    rhGet("/accounts/",token),rhGet("/portfolios/",token)
  ]);
  if(posR.status===401||acctR.status===401) return res.status(401).json({error:"Session expired."});

  const rawPos=[...(posR.data.results||[])];
  if(posR.data.next){const more=await paginateAll(posR.data.next,token,190);rawPos.push(...more);}

  const instUrls=[...new Set(rawPos.map(p=>p.instrument).filter(Boolean))];
  const insts={};
  const chunks=[];
  for(let i=0;i<instUrls.length;i+=10) chunks.push(instUrls.slice(i,i+10));
  for(const chunk of chunks) await Promise.all(chunk.map(async url=>{const{data}=await rhGet(url,token);if(data.symbol)insts[url]=data;}));

  const syms=[...new Set(Object.values(insts).map(i=>i.symbol).filter(Boolean))];
  const quotes={};
  for(let i=0;i<syms.length;i+=75){const batch=syms.slice(i,i+75);const{data}=await rhGet("/quotes/?symbols="+batch.join(","),token);(data.results||[]).forEach(q=>{if(q?.symbol)quotes[q.symbol]=q;});}

  const positions=rawPos.map(pos=>{
    const inst=insts[pos.instrument]||{}, quote=quotes[inst.symbol]||{};
    const qty=parseFloat(pos.quantity)||0, avg=parseFloat(pos.average_buy_price)||0;
    const cur=parseFloat(quote.last_trade_price||quote.last_extended_hours_trade_price||avg);
    const mkt=qty*cur, cost=qty*avg, plD=mkt-cost, plP=cost>0?(plD/cost)*100:0;
    return {symbol:inst.symbol||"N/A",name:inst.simple_name||inst.name||"Unknown",type:inst.type||"stock",quantity:qty,avgCost:avg,currentPrice:cur,marketValue:mkt,costBasis:cost,plDollar:plD,plPct:plP};
  }).filter(p=>p.quantity>0&&p.symbol!=="N/A").sort((a,b)=>b.marketValue-a.marketValue);

  const acct=acctR.data?.results?.[0]||{}, port=portR.data?.results?.[0]||{};
  const totalEquity=parseFloat(port.equity)||positions.reduce((s,p)=>s+p.marketValue,0);
  const prevClose=parseFloat(port.equity_previous_close)||totalEquity;
  const dayChange=totalEquity-prevClose, dayChangePct=prevClose>0?(dayChange/prevClose)*100:0;
  const cash=parseFloat(acct.buying_power||acct.cash||acct.portfolio_cash||"0");
  stats.portfolioScans++;
  res.json({success:true,data:{positions,summary:{totalEquity,dayChange,dayChangePct,cash,totalPositions:positions.length}}});
});

// ── POST /api/portfolio-analyze
app.post("/api/portfolio-analyze", analyzeLim, async (req,res) => {
  const {positions,summary,profile}=req.body;
  if(!positions?.length) return res.status(400).json({error:"Positions required."});
  const lines=positions.slice(0,50).map(p=>`${p.symbol}(${p.name}): ${p.quantity} shares, avg $${(p.avgCost||0).toFixed(2)}, cur $${(p.currentPrice||0).toFixed(2)}, val $${(p.marketValue||0).toFixed(2)}, P&L ${p.plDollar>=0?"+":""}$${(p.plDollar||0).toFixed(2)}(${(p.plPct||0).toFixed(1)}%)`).join("\n");
  const prompt=`Analyze portfolio:\nSummary: equity $${(summary.totalEquity||0).toFixed(2)}, cash $${(summary.cash||0).toFixed(2)}, ${summary.totalPositions} positions\nHoldings:\n${lines}\nProfile: ${JSON.stringify(profile||{})}\n\nRespond ONLY raw JSON:\n{"diversification_score":number,"risk_level":"Low|Moderate|High|Very High","overall_grade":"A+|A|B+|B|C+|C|D","one_liner":"string","overview":"string","key_insights":["string"],"top_actions":[{"priority":"High|Medium|Low","type":"string","symbol":"string|null","action_text":"string","reasoning":"string"}],"cash_recommendation":"string","biggest_risks":["string"],"sector_breakdown":[{"sector":"string","pct":number,"status":"Overweight|Good|Underweight"}],"winners_to_trim":[{"symbol":"string","reason":"string"}],"losers_to_cut":[{"symbol":"string","reason":"string"}],"missing_exposure":["string"],"tax_insight":"string","summary_bullets":["string"]}`;
  try {
    const msg=await client.messages.create({model:MODEL,max_tokens:2500,system:ANALYST+"\nRespond ONLY raw JSON.",messages:[{role:"user",content:prompt}]});
    res.json({success:true,data:parseJSON(msg.content[0].text)});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── POST /api/portfolio/manual
app.post("/api/portfolio/manual", analyzeLim, async (req,res) => {
  const {holdings}=req.body;
  if(!Array.isArray(holdings)||!holdings.length) return res.status(400).json({error:"holdings required."});
  const positions=holdings.map(h=>{
    const qty=parseFloat(h.quantity)||0, avg=parseFloat(h.avgCost)||0, cur=parseFloat(h.currentPrice)||avg;
    const mkt=qty*cur, cost=qty*avg, plD=mkt-cost, plP=cost>0?(plD/cost)*100:0;
    return {symbol:(h.symbol||"").toUpperCase()||"N/A",name:h.name||h.symbol||"Unknown",type:"stock",quantity:qty,avgCost:avg,currentPrice:cur,marketValue:mkt,costBasis:cost,plDollar:plD,plPct:plP};
  }).filter(p=>p.quantity>0&&p.symbol!=="N/A").sort((a,b)=>b.marketValue-a.marketValue);
  const totalEquity=positions.reduce((s,p)=>s+p.marketValue,0);
  const cashPos=holdings.find(h=>(h.symbol||"").toUpperCase()==="CASH");
  const cash=cashPos?parseFloat(cashPos.avgCost||0)*parseFloat(cashPos.quantity||1):0;
  res.json({success:true,data:{positions,summary:{totalEquity,dayChange:0,dayChangePct:0,cash,totalPositions:positions.length}}});
});

app.get("/api/stats",(_,res)=>res.json({...stats,uptimeHours:Math.floor((Date.now()-startTime)/3600000),quantumProtection:"AES-256-GCM (ML-KEM-768 in production)"}));

app.post("/api/generate", genLim, async (req,res) => {
  const {amount,horizon,risk,style,sectors,context,portfolioContext}=req.body;
  if(!amount||!horizon||!risk||!style) return res.status(400).json({error:"Missing fields."});
  const sects=Array.isArray(sectors)&&sectors.length?sectors.join(", "):"any sector";
  const pc=portfolioContext?"\n\nCURRENT PORTFOLIO (avoid overlap):\n"+portfolioContext:"";
  const prompt=`Generate 6 investment ideas:\n- Amount: ${amount}\n- Horizon: ${HORIZON[horizon]||horizon}\n- Risk: ${RISK[risk]||risk}\n- Style: ${STYLE[style]||style}\n- Sectors: ${sects}\n${context?"- Context: "+context:""}${pc}\n\nRespond ONLY raw JSON:\n{"ideas":[{"name":"string","ticker":"string|null","description":"string","risk":"Low risk|Moderate risk|High risk","allocation":number,"category":"Stocks|ETF|Bonds|Real Estate|Crypto|Commodities|Cash","sector":"string","upside":"string","volatility":"Low|Medium|High","why_now":"string","tags":["string"]}],"summary":{"overall_risk":"Conservative|Moderate|Aggressive","expected_return":"string","diversification":"string","top_pick":"string"},"analysis":"string"}`;
  try {
    const msg=await client.messages.create({model:MODEL,max_tokens:2500,system:ANALYST+"\nRespond ONLY raw JSON.",messages:[{role:"user",content:prompt}]});
    const data=parseJSON(msg.content[0].text);
    if(!data.ideas?.length) throw new Error("No ideas generated.");
    stats.generations++;
    res.json({success:true,data});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/chat", chatLim, async (req,res) => {
  const {messages,question,profileSummary}=req.body;
  if(!question||!Array.isArray(messages)) return res.status(400).json({error:"Missing fields."});
  if(question.length>1200) return res.status(400).json({error:"Question too long."});
  res.setHeader("Content-Type","text/event-stream");res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");res.setHeader("X-Accel-Buffering","no");res.flushHeaders();
  const send=obj=>res.write("data: "+JSON.stringify(obj)+"\n\n");
  try {
    const stream=await client.messages.stream({model:MODEL,max_tokens:1000,
      system:ANALYST+(profileSummary?"\n\nContext: "+profileSummary:"")+"\n\nAnswer concisely.",
      messages:[...messages,{role:"user",content:question+"\n\nBe direct. Plain text only."}]
    });
    stream.on("text",t=>send({text:t}));
    stream.on("finalMessage",()=>{send({done:true});res.end();stats.chats++;});
    stream.on("error",e=>{send({error:e.message});res.end();});
    req.on("close",()=>stream.abort());
  } catch(e) { if(!res.headersSent) res.status(500).json({error:e.message}); else{send({error:e.message});res.end();} }
});

app.post("/api/compare", compareLim, async (req,res) => {
  const {idea1,idea2,profile}=req.body;
  if(!idea1?.name||!idea2?.name) return res.status(400).json({error:"Both ideas required."});
  const prompt=`Compare for: ${JSON.stringify(profile||{})}\nA: ${JSON.stringify(idea1)}\nB: ${JSON.stringify(idea2)}\n\nRespond ONLY raw JSON:\n{"winner":"A|B|tie","verdict":"string","reasoning":"string","metrics":[{"metric":"string","A":"string","B":"string","winner":"A|B|tie"}],"A_pros":["string"],"A_cons":["string"],"B_pros":["string"],"B_cons":["string"],"best_for_A":"string","best_for_B":"string","scenarios":[{"name":"string","pick":"A|B","reason":"string"}]}`;
  try {
    const msg=await client.messages.create({model:MODEL,max_tokens:1800,system:ANALYST+"\nRespond ONLY raw JSON.",messages:[{role:"user",content:prompt}]});
    stats.comparisons++;
    res.json({success:true,data:parseJSON(msg.content[0].text)});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/api/analyze", analyzeLim, async (req,res) => {
  const {idea,profile}=req.body;
  if(!idea?.name) return res.status(400).json({error:"Idea required."});
  const prompt=`Deep-dive for: ${JSON.stringify(profile||{})}\nIdea: ${JSON.stringify(idea)}\n\nRespond ONLY raw JSON:\n{"score":number,"grade":"A+|A|B+|B|C+|C|D","sentiment":"bullish|neutral|cautious|bearish","one_liner":"string","overview":"string","pros":["string"],"cons":["string"],"key_risks":["string"],"entry_strategy":"string","exit_strategy":"string","position_size":"string","time_to_value":"string","due_diligence":["string"],"catalysts":["string"],"watch_metrics":["string"],"alternatives":[{"name":"string","ticker":"string|null","why":"string"}]}`;
  try {
    const msg=await client.messages.create({model:MODEL,max_tokens:1800,system:ANALYST+"\nRespond ONLY raw JSON.",messages:[{role:"user",content:prompt}]});
    stats.analyzes++;
    res.json({success:true,data:parseJSON(msg.content[0].text)});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/api/health",(_,res)=>res.json({status:"ok",model:MODEL,quantumProtection:"AES-256-GCM",...stats}));
app.get("*",(_,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT,()=>console.log(`QuantumInvest running on http://localhost:${PORT} | Crypto: AES-256-GCM | Model: ${MODEL}`));
module.exports=app;
