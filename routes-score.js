// routes-score.js — Confluence scoring for TW stocks (buy/sell suggestions)
// Sources: your own endpoints + FinMind (best effort) + TWSE STOCK_DAY fallback.
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// 可用環境變數微調權重（預設已合理）
const W_TREND = Number(process.env.SCORE_W_TREND ?? 0.20);
const W_MOMO  = Number(process.env.SCORE_W_MOM  ?? 0.30);
const W_VOL   = Number(process.env.SCORE_W_VOL  ?? 0.10);
const W_FLOW  = Number(process.env.SCORE_W_FLOW ?? 0.25);
const W_MACRO = Number(process.env.SCORE_W_MACRO?? 0.15);

// —— 基本 helpers ——
const clamp01 = (x)=> Math.max(0, Math.min(1, x));
const avg = (arr)=> arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
const last = (arr)=> arr[arr.length-1];

const tickSize = (p)=>{
  if (p < 10) return 0.01;
  if (p < 50) return 0.05;
  if (p < 100) return 0.1;
  if (p < 500) return 0.5;
  if (p < 1000) return 1;
  return 5;
};
const roundToTick = (p)=>{
  if (p == null || !isFinite(p)) return null;
  const t = tickSize(p);
  return +(Math.round(p / t) * t).toFixed(t < 0.1 ? 2 : t < 1 ? 1 : 0);
};
const toNum = (s)=> {
  if (s == null) return null;
  const n = Number(String(s).replace(/[, ]/g,'').replace(/--/g,''));
  return isFinite(n) ? n : null;
};

async function loadSymbols(baseDir = process.cwd()){
  const p = path.join(baseDir, process.env.SYMBOLS_PATH || './symbols.json');
  try { return JSON.parse(await fs.readFile(p,'utf8')); } catch { return { byCode:{}, byName:{} }; }
}

async function getIntl(base){
  try { const r = await axios.get(`${base}/intl/market_snapshot`, { headers:{'User-Agent':UA}, timeout: 10000 }); return r.data||null; }
  catch { return null; }
}
async function getQuotes(base, codes){
  try { const r = await axios.get(`${base}/tw/quote?codes=${encodeURIComponent(codes.join(','))}`, { headers:{'User-Agent':UA}, timeout: 12000 }); return r.data?.quotes||[]; }
  catch { return []; }
}

// —— 歷史價：FinMind（優先）→ TWSE STOCK_DAY（備援，無金鑰） ——
// rows 目標欄位：{ date:'YYYY-MM-DD', open, high, low, close, Trading_Volume }
async function finmindPriceHistory(code, days=60){
  try{
    const end = new Date();
    const yyyy = end.getFullYear(), mm = String(end.getMonth()+1).padStart(2,'0'), dd = String(end.getDate()).padStart(2,'0');
    const start = new Date(end.getTime() - days*86400000);
    const s = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`;
    const url = 'https://api.finmindtrade.com/api/v4/data';
    const params = { dataset:'TaiwanStockPrice', stock_id: code, start_date: s, end_date: `${yyyy}-${mm}-${dd}` };
    if (process.env.FINMIND_TOKEN) params.token = process.env.FINMIND_TOKEN;
    const { data } = await axios.get(url, { params, timeout: 12000, headers:{'User-Agent':UA} });
    let rows = data?.data || [];
    // 正規化欄名
    rows = rows.map(r=>({
      date: (r.date || r.Date),
      open: toNum(r.open || r.Open),
      high: toNum(r.max  || r.high || r.High),
      low:  toNum(r.min  || r.low  || r.Low),
      close:toNum(r.close|| r.Close),
      Trading_Volume: toNum(r.Trading_Volume || r.volume)
    })).filter(r=>r.date && isFinite(r.close));
    return rows;
  }catch{ return []; }
}

function yyyymm1(d){
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth()+1).padStart(2,'0');
  return `${yyyy}${mm}01`;
}
// TWSE 月檔：STOCK_DAY（上市）
async function twseStockDayMonth(code, dateYYYYMM01){
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateYYYYMM01}&stockNo=${code}`;
  const { data } = await axios.get(url, { timeout: 12000, headers:{'User-Agent':UA, 'Referer':'https://www.twse.com.tw/'} });
  if (data?.stat !== 'OK' || !Array.isArray(data?.data)) return [];
  return data.data.map(row=>{
    // row: [日期, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌價差, 成交筆數]
    const date = String(row[0]).replace(/\//g,'-');
    return {
      date,
      open: toNum(row[3]),
      high: toNum(row[4]),
      low:  toNum(row[5]),
      close:toNum(row[6]),
      Trading_Volume: toNum(row[1]) // 股數，先不換算張
    };
  }).filter(r=>isFinite(r.close));
}
async function twsePriceHistory(code, days=60){
  // 取近 4~6 個月直到滿足 days
  const out = [];
  for (let i=0;i<6 && out.length<days+5;i++){
    const d = new Date(); d.setMonth(d.getMonth()-i);
    const mrows = await twseStockDayMonth(code, yyyymm1(d));
    out.push(...mrows);
  }
  // 依日期排序（保險起見）
  out.sort((a,b)=> a.date < b.date ? -1 : 1);
  // 僅取最後 days+5 筆，足夠算指標
  return out.slice(-Math.max(days+5, 20));
}

// —— 法人買賣（FinMind，沒有就當 0） ——
async function finmindInstFlows(code, days=5){
  try{
    const end = new Date();
    const yyyy = end.getFullYear(), mm = String(end.getMonth()+1).padStart(2,'0'), dd = String(end.getDate()).padStart(2,'0');
    const start = new Date(end.getTime() - Math.max(days*2, 10)*86400000);
    const s = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`;
    const url = 'https://api.finmindtrade.com/api/v4/data';
    const params = { dataset:'TaiwanStockInstitutionalInvestorsBuySell', stock_id: code, start_date: s, end_date: `${yyyy}-${mm}-${dd}` };
    if (process.env.FINMIND_TOKEN) params.token = process.env.FINMIND_TOKEN;
    const { data } = await axios.get(url, { params, timeout: 12000, headers:{'User-Agent':UA} });
    const rows = data?.data || [];
    const byDate = new Map();
    for (const it of rows){
      const d  = it.date || it.Date;
      const b  = Number(it.buy  ?? it.Buy  ?? 0);
      const s2 = Number(it.sell ?? it.Sell ?? 0);
      const net = Number((it.net_buy_sell ?? it.NetBuySell ?? (b - s2)) ?? 0);
      byDate.set(d, (byDate.get(d) || 0) + net);
    }
    const dates = Array.from(byDate.keys()).sort();
    const lastN = dates.slice(-days);
    const sum5  = lastN.reduce((a,d)=> a + (byDate.get(d)||0), 0);
    const last1 = byDate.get(dates[dates.length-1]) || 0;
    return { sum5, last1 };
  }catch{ return { sum5:0, last1:0 }; }
}

// —— 技術指標 ——
const sma = (arr,n)=> arr.length<n? null : avg(arr.slice(-n));
const roc = (arr,n)=> arr.length<=n? null : ((arr[arr.length-1]/arr[arr.length-1-n]-1)*100);
function atr14(rows){
  if (rows.length < 15) return null;
  const cs = rows.map(r=>Number(r.close));
  const hs = rows.map(r=>Number(r.high));
  const ls = rows.map(r=>Number(r.low));
  const trs = [];
  for (let i=1;i<rows.length;i++){
    trs.push(Math.max(hs[i]-ls[i], Math.abs(hs[i]-cs[i-1]), Math.abs(ls[i]-cs[i-1])));
  }
  return avg(trs.slice(-14));
}
const highN = (rows,n=20)=> rows.slice(-n).reduce((m,r)=> Math.max(m, Number(r.high)||-Infinity), -Infinity);
const lowN  = (rows,n=20)=> rows.slice(-n).reduce((m,r)=> Math.min(m, Number(r.low )|| Infinity),  Infinity);

// —— 分數子模型 ——
function scoreTrend(close, sma5, sma20){
  let s = 0.5;
  if (close != null && sma20 != null) s += close > sma20 ? 0.5 : -0.2;
  if (sma5 != null && sma20 != null) s += sma5 > sma20 ? 0.3 : -0.1;
  return clamp01(s);
}
function scoreMomo(roc5){ if (roc5 == null) return 0.5; return clamp01((roc5 - (-5)) / (8 - (-5))); }
function scoreVol(relVol){ if (relVol == null) return 0.5; return clamp01((relVol - 0.8) / (1.6 - 0.8)); }
function scoreFlow(sum5,last1){ let s=0.5; if(sum5>0)s+=0.3; else if(sum5<0)s-=0.3; if(last1>0)s+=0.2; else if(last1<0)s-=0.2; return clamp01(s); }
function scoreMacro(intl){
  if (!intl) return 0.5;
  let s=0.5;
  const pct=(x)=> (x && isFinite(x.pct))? x.pct : null;
  const sox=pct(intl.sox), spx=pct(intl.spx), vix=pct(intl.vix), dxy=pct(intl.dxy);
  if (sox!=null) s += sox>=0? 0.2 : -0.2;
  if (spx!=null) s += spx>=0? 0.1 : -0.1;
  if (vix!=null) s += vix<=0? 0.1 : -0.1;
  if (dxy!=null) s += dxy<=0? 0.1 : -0.1;
  return clamp01(s);
}

function decidePlan(close, atr, hi20, lo20, totalScore){
  const bias = totalScore >= 0.65 ? '偏多' : totalScore <= 0.45 ? '偏空' : '觀望';
  if (!isFinite(close) || !isFinite(atr)) {
    return { bias, key: hi20 || null, bid: null, stop: null, t1: null, t2: null, plan: '資料不足，先觀望', note: '' };
  }
  if (bias === '偏多'){
    const entry = Math.max(close, isFinite(hi20)? hi20*1.001 : close);
    const stop  = entry - 1.2*atr;
    const t1    = entry + 1.0*atr;
    const t2    = entry + 2.0*atr;
    const key   = isFinite(hi20) ? hi20 : entry;
    const bidLo = close - 0.5*atr, bidHi = close - 0.2*atr;
    return { bias, key:roundToTick(key), bid:`${roundToTick(bidLo)}~${roundToTick(bidHi)}`, stop:roundToTick(stop), t1:roundToTick(t1), t2:roundToTick(t2), plan:'量能不縮、站上關鍵價可續攻；跌破停損出場', note:'ATR(14)做區間；突破追、回檔分批' };
  }
  if (bias === '觀望'){
    const key = isFinite(hi20)? hi20 : null;
    const bidLo = close - 0.6*atr, bidHi = close - 0.3*atr;
    const stop  = close - 0.9*atr;
    return { bias, key:roundToTick(key), bid:`${roundToTick(bidLo)}~${roundToTick(bidHi)}`, stop:roundToTick(stop), t1:null, t2:null, plan:'等待放量站上關鍵價；不到位不追價', note:'縮量不打擾；關鍵價附近再看盤中強度' };
  }
  const stop = close - 0.8*atr;
  return { bias, key:isFinite(lo20)? roundToTick(lo20):null, bid:null, stop:roundToTick(stop), t1:null, t2:null, plan:'反彈減碼，跌破關鍵價嚴格停損', note:'弱勢股不撿；等右側訊號再說' };
}

// —— HTTP 路由 ——
module.exports = function mountScore(app){
  // GET /score/confluence?codes=2330,2603  （不給 codes → 取 /watchlist 全部）
  app.get('/score/confluence', async (req, res)=>{
    const base = `${req.protocol}://${req.get('host')}`;
    try{
      let codes = (req.query.codes || '').toString().split(',').map(s=>s.trim()).filter(Boolean);
      let names = {};
      const sym = await loadSymbols();
      if (!codes.length){
        try{
          const wl = (await axios.get(`${base}/watchlist`, { headers:{'User-Agent':UA} })).data;
          codes = [...(wl.self||[]), ...(wl.mom||[])].map(x=>x.code);
          wl.self?.forEach(x=> names[x.code]=x.name);
          wl.mom?.forEach (x=> names[x.code]=x.name);
        }catch{}
      }
      codes = Array.from(new Set(codes));

      const intl    = await getIntl(base);
      const macroS  = scoreMacro(intl);
      const quotes  = await getQuotes(base, codes);
      const quoteBy = new Map(quotes.map(q=> [q.code, q]));

      const out = [];
      for (const code of codes){
        const q = quoteBy.get(code) || {};
        const close = Number(q.price);

        // 先 FinMind，空的話換 TWSE 月檔
        let hist = await finmindPriceHistory(code, 60);
        if (!hist.length) hist = await twsePriceHistory(code, 60);

        if (!hist.length){
          out.push({ code, name: names[code] || sym.byCode?.[code] || (q.name || ''), score:null, reason:'no_history' });
          continue;
        }

        const closes = hist.map(r=>Number(r.close)).filter(n=>isFinite(n));
        const vols   = hist.map(r=>Number(r.Trading_Volume)).filter(n=>isFinite(n));
        const sma5   = sma(closes,5);
        const sma20  = sma(closes,20);
        const roc5   = roc(closes,5);
        const vAvg20 = sma(vols,20);
        const vRel   = (Number(last(vols)) && vAvg20)? (Number(last(vols))/vAvg20) : null;
        const atr    = atr14(hist);
        const hi20   = highN(hist,20);
        const lo20   = lowN(hist,20);

        const flow   = await finmindInstFlows(code, 5);

        const sTrend = scoreTrend(close, sma5, sma20);
        const sMomo  = scoreMomo(roc5);
        const sVol   = scoreVol(vRel);
        const sFlow  = scoreFlow(flow.sum5, flow.last1);

        const total  = clamp01(W_TREND*sTrend + W_MOMO*sMomo + W_VOL*sVol + W_FLOW*sFlow + W_MACRO*macroS);
        const plan   = decidePlan(close, atr ?? 0, hi20, lo20, total);

        out.push({
          code,
          name: names[code] || sym.byCode?.[code] || (q.name || ''),
          refClose: isFinite(close) ? close : (isFinite(last(closes)) ? last(closes) : null),
          indicators: { sma5, sma20, roc5, relVol: vRel, atr14: atr, hi20, lo20, instFlow5d: flow.sum5, instFlow1d: flow.last1, macroS },
          subscores:  { trend: sTrend, momo: sMomo, vol: sVol, flow: sFlow, macro: macroS },
          score: +(total*100).toFixed(0),
          suggestion: { bias: plan.bias, key: plan.key, bid: plan.bid, stop: plan.stop, t1: plan.t1, t2: plan.t2, plan: plan.plan, note: plan.note }
        });
      }
      res.json({ ok:true, items: out, date: new Date().toISOString().slice(0,10) });
    }catch(e){
      res.status(500).json({ ok:false, error: String(e?.message||e) });
    }
  });
};
