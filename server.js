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

if (!process.env.ANTHROPIC_API_KEY) { console.error("FATAL: ANTHROPIC_API_KEY not set"); process.exit(1); }
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let stats = { analyses:0, simulations:0, ideas:0, chats:0 };
const startTime = Date.now();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ? Buffer.from(process.env.ENCRYPTION_KEY,"hex") : crypto.randomBytes(32);

app.use(helmet({ contentSecurityPolicy:{ directives:{ defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'"],scriptSrcAttr:["'none'"],styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com"],fontSrc:["'self'","https://fonts.gstatic.com"],connectSrc:["'self'"],imgSrc:["'self'","data:","https:"],objectSrc:["'none'"],baseUri:["'self'"] } } }));
app.use(cors({ origin: process.env.FRONTEND_URL||"*", methods:["GET","POST"] }));
app.use(express.json({ limit:"128kb" }));
app.use(express.static(path.join(__dirname,"public")));

const lim = (max,win) => rateLimit({windowMs:win*1000,max,standardHeaders:true,legacyHeaders:false,message:{error:"Too many requests."}});
app.use("/api/",lim(200,15*60));
const analyzeLim=lim(15,60), genLim=lim(5,60), chatLim=lim(30,60), rhLim=lim(8,60);

const ANALYST=`You are a senior portfolio manager and CFA charterholder with 25+ years of experience. You combine fundamental analysis, technical analysis, and macro context. Every recommendation must cite specific data: P/E ratios, RSI values, patterns, growth rates. Be specific — name tickers, amounts, price targets.`;

function parseJSON(raw){
  const c=raw.trim().replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/```\s*$/i,"").trim();
  try{return JSON.parse(c);}catch(e){const m=c.match(/\{[\s\S]*\}/);if(m){try{return JSON.parse(m[0]);}catch(_){}}throw new Error("AI returned malformed response.");}
}

// ── Yahoo Finance helpers
const YFH={"User-Agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36","Accept":"application/json,*/*"};
async function yfGet(url){try{const r=await axios.get(url,{headers:YFH,timeout:8000,validateStatus:()=>true});return r.status===200?r.data:null;}catch(e){return null;}}

async function fetchHistory(symbol){
  const end=Math.floor(Date.now()/1000), start=end-365*86400;
  const data=await yfGet(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${start}&period2=${end}`);
  if(!data?.chart?.result?.[0]) return null;
  const r=data.chart.result[0], ts=r.timestamps||[], q=r.indicators?.quote?.[0]||{};
  const adj=r.indicators?.adjclose?.[0]?.adjclose||q.close||[];
  const out=[];
  for(let i=0;i<ts.length;i++){
    if(q.close[i]==null) continue;
    out.push({date:new Date(ts[i]*1000).toISOString().slice(0,10),open:q.open[i],high:q.high[i],low:q.low[i],close:q.close[i],adjClose:adj[i]||q.close[i],volume:q.volume[i]||0});
  }
  return out;
}

async function fetchFundamentals(symbol){
  const data=await yfGet(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=summaryDetail,defaultKeyStatistics,financialData,assetProfile,recommendationTrend`);
  if(!data?.quoteSummary?.result?.[0]) return null;
  const r=data.quoteSummary.result[0];
  const sd=r.summaryDetail||{},ks=r.defaultKeyStatistics||{},fd=r.financialData||{},ap=r.assetProfile||{},rt=r.recommendationTrend?.trend?.[0]||{};
  return {
    sector:ap.sector||"",industry:ap.industry||"",
    pe:sd.trailingPE?.raw||null,forwardPE:sd.forwardPE?.raw||null,peg:ks.pegRatio?.raw||null,pb:ks.priceToBook?.raw||null,
    epsGrowthYoY:ks.earningsQuarterlyGrowth?.raw||null,revenueGrowth:fd.revenueGrowth?.raw||null,
    profitMargin:fd.profitMargins?.raw||null,roe:fd.returnOnEquity?.raw||null,debtEquity:fd.debtToEquity?.raw||null,
    analystTarget:fd.targetMeanPrice?.raw||null,analystHigh:fd.targetHighPrice?.raw||null,analystLow:fd.targetLowPrice?.raw||null,
    recommendation:fd.recommendationKey||null,dividendYield:sd.dividendYield?.raw||null,beta:sd.beta?.raw||null,
    fiftyTwoHigh:sd.fiftyTwoWeekHigh?.raw||null,fiftyTwoLow:sd.fiftyTwoWeekLow?.raw||null,
    analystBuy:(rt.strongBuy||0)+(rt.buy||0),analystHold:rt.hold||0,analystSell:(rt.strongSell||0)+(rt.sell||0),
    analystCount:(rt.strongBuy||0)+(rt.buy||0)+(rt.hold||0)+(rt.sell||0)+(rt.strongSell||0),
  };
}

// ── Technical indicators
function sma(arr,n){return arr.map((_,i)=>i<n-1?null:arr.slice(i-n+1,i+1).reduce((a,b)=>a+b,0)/n);}
function ema(arr,n){const k=2/(n+1),out=[];for(let i=0;i<arr.length;i++){out.push(i===0?arr[i]:arr[i]*k+out[i-1]*(1-k));}return out;}
function stddev(arr){const m=arr.reduce((a,b)=>a+b,0)/arr.length;return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length);}

function computeRSI(closes,period=14){
  const gains=[],losses=[];
  for(let i=1;i<closes.length;i++){const d=closes[i]-closes[i-1];gains.push(d>0?d:0);losses.push(d<0?-d:0);}
  let ag=gains.slice(0,period).reduce((a,b)=>a+b,0)/period,al=losses.slice(0,period).reduce((a,b)=>a+b,0)/period;
  const rsi=[null];
  for(let i=0;i<gains.length;i++){
    if(i<period){rsi.push(null);continue;}
    ag=(ag*(period-1)+gains[i])/period; al=(al*(period-1)+losses[i])/period;
    rsi.push(al===0?100:100-(100/(1+ag/al)));
  }
  return rsi;
}

function computeMACD(closes){
  const e12=ema(closes,12),e26=ema(closes,26);
  const macdLine=closes.map((_,i)=>e12[i]-e26[i]);
  const signalLine=ema(macdLine,9);
  const histogram=macdLine.map((v,i)=>v-(signalLine[i]||0));
  return{macd:macdLine,signal:signalLine,histogram};
}

function computeBB(closes,period=20,mult=2){
  const mid=sma(closes,period),upper=[],lower=[];
  for(let i=0;i<closes.length;i++){
    if(mid[i]==null){upper.push(null);lower.push(null);continue;}
    const sd=stddev(closes.slice(i-period+1,i+1));
    upper.push(mid[i]+mult*sd);lower.push(mid[i]-mult*sd);
  }
  return{upper,mid,lower};
}

function detectPatterns(candles){
  const patterns=[];
  if(candles.length<3) return patterns;
  const last=candles[candles.length-1],prev=candles[candles.length-2],prev2=candles[candles.length-3];
  const body=c=>Math.abs(c.close-c.open),range=c=>c.high-c.low;
  const bull=c=>c.close>c.open,bear=c=>c.close<c.open;
  if(range(last)>0&&body(last)/range(last)<0.1) patterns.push({name:"Doji",signal:"neutral",desc:"Indecision candle — watch for breakout direction"});
  const lw=Math.min(last.open,last.close)-last.low,uw=last.high-Math.max(last.open,last.close);
  if(lw>2*body(last)&&uw<body(last)&&bear(prev)) patterns.push({name:"Hammer",signal:"bullish",desc:"Potential bullish reversal — buyers rejected lower prices"});
  if(uw>2*body(last)&&lw<body(last)&&bull(prev)) patterns.push({name:"Shooting Star",signal:"bearish",desc:"Potential bearish reversal — sellers rejected higher prices"});
  if(bear(prev)&&bull(last)&&last.open<prev.close&&last.close>prev.open) patterns.push({name:"Bullish Engulfing",signal:"bullish",desc:"Strong buying signal — bulls overwhelmed bears"});
  if(bull(prev)&&bear(last)&&last.open>prev.close&&last.close<prev.open) patterns.push({name:"Bearish Engulfing",signal:"bearish",desc:"Strong selling signal — bears overwhelmed bulls"});
  if(bull(last)&&bull(prev)&&bull(prev2)&&last.close>prev.close&&prev.close>prev2.close) patterns.push({name:"Three White Soldiers",signal:"bullish",desc:"Three consecutive up days — strong upward momentum"});
  if(bear(last)&&bear(prev)&&bear(prev2)&&last.close<prev.close&&prev.close<prev2.close) patterns.push({name:"Three Black Crows",signal:"bearish",desc:"Three consecutive down days — strong downward momentum"});
  return patterns;
}

async function analyzeTechnical(symbol){
  const history=await fetchHistory(symbol);
  if(!history||history.length<30) return null;
  const closes=history.map(d=>d.adjClose),highs=history.map(d=>d.high),lows=history.map(d=>d.low);
  const rsi=computeRSI(closes),macd=computeMACD(closes),bb=computeBB(closes);
  const ma20=sma(closes,20),ma50=sma(closes,50),ma200=sma(closes,200);
  const n=closes.length;
  const last=closes[n-1],m20=ma20[n-1],m50=ma50[n-1],m200=ma200[n-1];
  let trend="sideways";
  if(last>m20&&m20>m50) trend="uptrend";
  if(last<m20&&m20<m50) trend="downtrend";
  const recent60={h:highs.slice(-60),l:lows.slice(-60)};
  const support=Math.min(...recent60.l),resistance=Math.max(...recent60.h);
  const returns=closes.slice(-252).map((_,i,a)=>i===0?null:Math.log(a[i]/a[i-1])).filter(Boolean);
  const annualVol=returns.length>10?stddev(returns)*Math.sqrt(252):0.25;
  const perf3m=n>=63?(closes[n-1]/closes[n-63]-1):null;
  const perf1y=n>=252?(closes[n-1]/closes[n-252]-1):null;
  const patterns=detectPatterns(history.slice(-5));
  const lastRSI=rsi[n-1],lastHist=macd.histogram[n-1],lastBBU=bb.upper[n-1],lastBBL=bb.lower[n-1];
  const signals=[];
  if(lastRSI!=null){
    if(lastRSI<30) signals.push({indicator:"RSI",value:lastRSI.toFixed(1),signal:"bullish",desc:"Oversold (<30)"});
    else if(lastRSI>70) signals.push({indicator:"RSI",value:lastRSI.toFixed(1),signal:"bearish",desc:"Overbought (>70)"});
    else signals.push({indicator:"RSI",value:lastRSI.toFixed(1),signal:"neutral",desc:"Neutral zone"});
  }
  if(lastHist!=null) signals.push({indicator:"MACD",value:lastHist.toFixed(4),signal:lastHist>0?"bullish":"bearish",desc:lastHist>0?"Positive histogram":"Negative histogram"});
  if(lastBBU&&lastBBL){const p=(last-lastBBL)/(lastBBU-lastBBL);if(p>0.85)signals.push({indicator:"BB",value:(p*100).toFixed(0)+"%",signal:"bearish",desc:"Near upper band"});else if(p<0.15)signals.push({indicator:"BB",value:(p*100).toFixed(0)+"%",signal:"bullish",desc:"Near lower band"});}
  if(m20&&m50) signals.push({indicator:"MA20/50",value:m20>m50?"20>50":"50>20",signal:m20>m50?"bullish":"bearish",desc:m20>m50?"Short MA above long MA":"Long MA above short MA"});
  const bullCount=signals.filter(s=>s.signal==="bullish").length+patterns.filter(p=>p.signal==="bullish").length;
  const bearCount=signals.filter(s=>s.signal==="bearish").length+patterns.filter(p=>p.signal==="bearish").length;
  const tot=bullCount+bearCount;
  const summary=tot===0?"neutral":bullCount/tot>=0.65?"bullish":bearCount/tot>=0.65?"bearish":"neutral";
  return {
    symbol,
    candles:history.slice(-90),
    dates:history.slice(-90).map(d=>d.date),
    closes:closes.slice(-90),
    volumes:history.slice(-90).map(d=>d.volume),
    rsi:rsi.slice(-90),
    macd:{line:macd.macd.slice(-90),signal:macd.signal.slice(-90),histogram:macd.histogram.slice(-90)},
    bb:{upper:bb.upper.slice(-90),mid:bb.mid.slice(-90),lower:bb.lower.slice(-90)},
    ma20:ma20.slice(-90),ma50:ma50.slice(-90),ma200:ma200.slice(-90),
    trend:{trend,support,resistance,annualVol,perf3m,perf1y,ma20:m20,ma50:m50,ma200:m200},
    signals,patterns,summary,
  };
}

// ── Monte Carlo
let _bmS=null,_bmH=false;
function boxMuller(){if(_bmH){_bmH=false;return _bmS;}let u,v,s;do{u=Math.random()*2-1;v=Math.random()*2-1;s=u*u+v*v;}while(s>=1||s===0);const m=Math.sqrt(-2*Math.log(s)/s);_bmS=v*m;_bmH=true;return u*m;}

function monteCarlo(positions,months=24,runs=600){
  const posData=positions.map(p=>({
    annualReturn:p.analystTarget&&p.currentPrice?(p.analystTarget/p.currentPrice-1):(p.historical?.trend?.perf1y||0.08),
    annualVol:p.historical?.trend?.annualVol||0.25,
    weight:p.weight||0,
  }));
  const portReturn=posData.reduce((s,p)=>s+p.weight*p.annualReturn,0);
  const portVol=Math.sqrt(posData.reduce((s,p)=>s+Math.pow(p.weight*p.annualVol,2),0));
  const dailyMu=portReturn/252,dailySig=portVol/Math.sqrt(252),days=months*21;
  const paths=[];
  for(let r=0;r<runs;r++){let val=1.0;const path=[1.0];for(let d=0;d<days;d++){val*=(1+dailyMu+dailySig*boxMuller());if(d%21===20)path.push(Math.max(0,val));}paths.push(path);}
  const numM=paths[0].length;
  const pct={p10:[],p25:[],p50:[],p75:[],p90:[]};
  for(let m=0;m<numM;m++){const v=paths.map(p=>p[m]).sort((a,b)=>a-b);pct.p10.push(v[Math.floor(runs*0.10)]);pct.p25.push(v[Math.floor(runs*0.25)]);pct.p50.push(v[Math.floor(runs*0.50)]);pct.p75.push(v[Math.floor(runs*0.75)]);pct.p90.push(v[Math.floor(runs*0.90)]);}
  return{percentiles:pct,portReturn,portVol,months};
}

// ══════════════════════════════════════════════════════
// API ENDPOINTS
// ══════════════════════════════════════════════════════

app.post("/api/full-analysis", analyzeLim, async (req,res)=>{
  const {holdings,profile}=req.body;
  if(!Array.isArray(holdings)||!holdings.length) return res.status(400).json({error:"holdings required."});
  const positions=holdings.filter(h=>(h.symbol||"").toUpperCase()!=="CASH").map(h=>{
    const qty=parseFloat(h.quantity)||0,avg=parseFloat(h.avgCost)||0,cur=parseFloat(h.currentPrice)||avg;
    const mkt=qty*cur,cost=qty*avg,plD=mkt-cost,plP=cost>0?(plD/cost)*100:0;
    return{symbol:(h.symbol||"").toUpperCase(),name:h.name||h.symbol,quantity:qty,avgCost:avg,currentPrice:cur,marketValue:mkt,costBasis:cost,plDollar:plD,plPct:plP};
  }).filter(p=>p.quantity>0&&p.symbol).sort((a,b)=>b.marketValue-a.marketValue);
  const totalEquity=positions.reduce((s,p)=>s+p.marketValue,0);
  const cashPos=holdings.find(h=>(h.symbol||"").toUpperCase()==="CASH");
  const cash=cashPos?parseFloat(cashPos.avgCost||0)*parseFloat(cashPos.quantity||1):0;
  positions.forEach(p=>{p.weight=totalEquity>0?p.marketValue/totalEquity:0;});
  const symbols=positions.slice(0,8).map(p=>p.symbol);
  const [fundsArr,techArr]=await Promise.all([
    Promise.all(symbols.map(s=>fetchFundamentals(s).catch(()=>null))),
    Promise.all(symbols.map(s=>analyzeTechnical(s).catch(()=>null))),
  ]);
  symbols.forEach((sym,i)=>{
    const pos=positions.find(p=>p.symbol===sym);if(!pos)return;
    pos.fundamentals=fundsArr[i];pos.technical=techArr[i];
    if(fundsArr[i]) pos.analystTarget=fundsArr[i].analystTarget;
    if(techArr[i])  pos.historical=techArr[i];
  });
  const posLines=positions.slice(0,8).map(p=>{
    const f=p.fundamentals,t=p.technical;
    const lines=[`\n== ${p.symbol} (${p.name}) ==`,
      `  Position: ${p.quantity}sh @$${p.avgCost.toFixed(2)} avg | Current: $${p.currentPrice.toFixed(2)} | Value: $${p.marketValue.toFixed(2)} | P&L: ${p.plDollar>=0?"+":""}$${p.plDollar.toFixed(2)} (${p.plPct.toFixed(1)}%) | Weight: ${(p.weight*100).toFixed(1)}%`];
    if(f){
      lines.push(`  Fundamentals: P/E=${f.pe?.toFixed(1)||"N/A"} | FwdP/E=${f.forwardPE?.toFixed(1)||"N/A"} | PEG=${f.peg?.toFixed(2)||"N/A"} | P/B=${f.pb?.toFixed(2)||"N/A"} | Beta=${f.beta?.toFixed(2)||"N/A"}`);
      lines.push(`  Growth: Revenue=${f.revenueGrowth!=null?(f.revenueGrowth*100).toFixed(1)+"%":"N/A"} | EPS_YoY=${f.epsGrowthYoY!=null?(f.epsGrowthYoY*100).toFixed(1)+"%":"N/A"} | ProfitMargin=${f.profitMargin!=null?(f.profitMargin*100).toFixed(1)+"%":"N/A"} | ROE=${f.roe!=null?(f.roe*100).toFixed(1)+"%":"N/A"}`);
      lines.push(`  Balance: DebtEquity=${f.debtEquity?.toFixed(2)||"N/A"} | DivYield=${f.dividendYield!=null?(f.dividendYield*100).toFixed(2)+"%":"N/A"} | 52W: $${f.fiftyTwoLow?.toFixed(2)||"?"}–$${f.fiftyTwoHigh?.toFixed(2)||"?"}`);
      if(f.analystTarget) lines.push(`  Analysts: Target=$${f.analystTarget.toFixed(2)} | ${f.analystBuy}Buy ${f.analystHold}Hold ${f.analystSell}Sell | Rec: ${f.recommendation||"N/A"}`);
    }
    if(t){
      const tr=t.trend;
      lines.push(`  Technical: ${tr.trend} | 3M=${tr.perf3m!=null?(tr.perf3m*100).toFixed(1)+"%":"N/A"} | 1Y=${tr.perf1y!=null?(tr.perf1y*100).toFixed(1)+"%":"N/A"} | Vol=${(tr.annualVol*100).toFixed(0)}%/yr`);
      lines.push(`  MAs: 20d=$${tr.ma20?.toFixed(2)||"?"} 50d=$${tr.ma50?.toFixed(2)||"?"} 200d=$${tr.ma200?.toFixed(2)||"?"} | Support=$${tr.support?.toFixed(2)||"?"} Resistance=$${tr.resistance?.toFixed(2)||"?"}`);
      if(t.signals.length) lines.push(`  Indicators: ${t.signals.map(s=>`${s.indicator}(${s.value},${s.signal})`).join(" ")}`);
      if(t.patterns.length) lines.push(`  Patterns: ${t.patterns.map(p=>`${p.name}(${p.signal})`).join(", ")}`);
    }
    return lines.join("\n");
  }).join("\n");
  const prompt=`Perform a complete investment analysis of this portfolio. Use ALL the fundamental and technical data provided.

PROFILE: Horizon=${profile?.horizon||"medium"} | Risk=${profile?.risk||"moderate"} | Goal=${profile?.goal||"balanced"}
PORTFOLIO: Total=$${totalEquity.toFixed(2)} | Cash=$${cash.toFixed(2)} | ${positions.length} positions

${posLines}

Every action MUST cite specific data (e.g. "NVDA RSI=78 overbought, P/E=65 vs sector avg 32 — trim 25%"). Be direct.

Respond ONLY raw JSON:
{"overall_grade":"A+|A|A-|B+|B|B-|C+|C|D","diversification_score":number,"risk_level":"Low|Moderate|High|Very High","one_liner":"string","overview":"string (3 sentences combining technical + fundamental)","key_strengths":["string"],"key_weaknesses":["string"],"top_actions":[{"priority":"High|Medium|Low","type":"Buy|Sell|Trim|Hold|Rebalance|Add|Stop Loss","symbol":"string|null","action_text":"string (precise action with size)","reasoning":"string (cite specific numbers)","target_price":number|null,"stop_loss":number|null}],"position_scores":[{"symbol":"string","score":number,"technical_view":"bullish|neutral|bearish","fundamental_view":"cheap|fair|expensive|N/A","verdict":"string"}],"sector_breakdown":[{"sector":"string","pct":number,"status":"Overweight|Good|Underweight"}],"cash_recommendation":"string","biggest_risks":["string"],"key_insights":["string"],"missing_exposure":["string"],"winners_to_trim":[{"symbol":"string","reason":"string","suggested_trim_pct":number}],"losers_to_cut":[{"symbol":"string","reason":"string"}],"tax_insight":"string","summary_bullets":["string"]}`;
  try{
    const msg=await client.messages.create({model:MODEL,max_tokens:3500,system:ANALYST+"\nRespond ONLY raw JSON.",messages:[{role:"user",content:prompt}]});
    const analysis=parseJSON(msg.content[0].text);
    stats.analyses++;
    res.json({success:true,data:{positions,summary:{totalEquity,dayChange:0,dayChangePct:0,cash,totalPositions:positions.length},analysis,technical:Object.fromEntries(symbols.map((s,i)=>[s,techArr[i]])),fundamentals:Object.fromEntries(symbols.map((s,i)=>[s,fundsArr[i]]))}});
  }catch(e){console.error("[full-analysis]",e.message);res.status(500).json({error:e.message});}
});

app.post("/api/simulate", analyzeLim, async (req,res)=>{
  const{positions,optimizedWeights,months=24}=req.body;
  if(!positions?.length) return res.status(400).json({error:"positions required."});
  const total=positions.reduce((s,p)=>s+(p.marketValue||0),0);
  positions.forEach(p=>{p.weight=total>0?(p.marketValue||0)/total:0;});
  const current=monteCarlo(positions,months,600);
  let optimized=null;
  if(optimizedWeights?.length){
    const opt=optimizedWeights.map(w=>{const pos=positions.find(p=>p.symbol===w.symbol)||{};return{...pos,weight:w.weight,analystTarget:w.analystTarget||pos.analystTarget};});
    optimized=monteCarlo(opt,months,600);
  }
  stats.simulations++;
  res.json({success:true,data:{current,optimized,totalEquity:total,months}});
});

app.post("/api/generate-gap-ideas", genLim, async (req,res)=>{
  const{analysis,positions,profile}=req.body;
  const missing=(analysis?.missing_exposure||[]).join(", ");
  const weaknesses=(analysis?.key_weaknesses||[]).join("; ");
  const current=(positions||[]).map(p=>p.symbol).join(", ");
  const prompt=`Generate 6 targeted investment ideas to FILL THE GAPS in this portfolio.
Current holdings: ${current}
Missing exposure: ${missing}
Key weaknesses: ${weaknesses}
Profile: Horizon=${profile?.horizon||"medium"} | Risk=${profile?.risk||"moderate"} | Goal=${profile?.goal||"balanced"}
DO NOT suggest: ${current}. Focus entirely on filling identified gaps.
Respond ONLY raw JSON:
{"ideas":[{"name":"string","ticker":"string|null","description":"string","risk":"Low risk|Moderate risk|High risk","allocation":number,"category":"Stocks|ETF|Bonds|Real Estate|Crypto|Commodities","sector":"string","upside":"string","why_now":"string","why_this_portfolio":"string (exactly how this fills the gap)","tags":["string"]}],"summary":{"rationale":"string"}}`;
  try{
    const msg=await client.messages.create({model:MODEL,max_tokens:2000,system:ANALYST+"\nRespond ONLY raw JSON.",messages:[{role:"user",content:prompt}]});
    const data=parseJSON(msg.content[0].text);
    stats.ideas++;
    res.json({success:true,data});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post("/api/chat", chatLim, async (req,res)=>{
  const{messages,question,portfolioSummary}=req.body;
  if(!question||!Array.isArray(messages)) return res.status(400).json({error:"Missing fields."});
  res.setHeader("Content-Type","text/event-stream");res.setHeader("Cache-Control","no-cache");res.setHeader("Connection","keep-alive");res.setHeader("X-Accel-Buffering","no");res.flushHeaders();
  const send=obj=>res.write("data: "+JSON.stringify(obj)+"\n\n");
  try{
    const stream=await client.messages.stream({model:MODEL,max_tokens:1200,system:ANALYST+(portfolioSummary?"\n\nPortfolio:\n"+portfolioSummary:"")+"\n\nCite specific tickers and numbers. Plain text only.",messages:[...messages,{role:"user",content:question+"\n\nBe specific. Plain text."}]});
    stream.on("text",t=>send({text:t}));stream.on("finalMessage",()=>{send({done:true});res.end();stats.chats++;});stream.on("error",e=>{send({error:e.message});res.end();});req.on("close",()=>stream.abort());
  }catch(e){if(!res.headersSent)res.status(500).json({error:e.message});else{send({error:e.message});res.end();}}
});

app.get("/api/stats",(_,res)=>res.json({...stats,uptimeHours:Math.floor((Date.now()-startTime)/3600000)}));
app.get("/api/health",(_,res)=>res.json({status:"ok",model:MODEL}));
app.get("*",(_,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`QuantumInvest v2 — http://localhost:${PORT} | Real technical analysis + Monte Carlo`));
module.exports=app;
