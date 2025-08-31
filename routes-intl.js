// routes-intl.js — International snapshot (parallel, multi-fallback, no API keys)
const axios = require('axios');
const RSSParser = require('rss-parser');
const parser = new RSSParser();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ---------- helpers ----------
const toNum = (x) => { const n = Number(String(x ?? '').trim()); return Number.isFinite(n) ? n : null; };
const pct = (a,b)=> (Number.isFinite(a)&&Number.isFinite(b)&&b!==0)? +(((a-b)/b)*100).toFixed(2): null;
const lastTwo = (rows)=>{ const v=rows.map(r=>toNum(r.value)).filter(Number.isFinite); return v.length<2?{last:null,prev:null}:{last:v[v.length-1],prev:v[v.length-2]}; };

// --- Stooq (try .pl then .com; with headers) ---
async function stooqCSV(symbol){
  const bases = ['https://stooq.pl', 'https://stooq.com'];
  let lastErr;
  for (const base of bases){
    try{
      const url = `${base}/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
      const { data } = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': UA, 'Referer': base + '/', 'Accept': 'text/csv' }
      });
      return String(data);
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error('stooq failed');
}
async function stooqDaily(symbol){
  const csv = await stooqCSV(symbol);
  const lines = csv.trim().split(/\r?\n/);
  const rows = [];
  for (let i=1;i<lines.length;i++){
    const [Date, Open, High, Low, Close] = lines[i].split(',');
    const v = toNum(Close);
    if (v!=null) rows.push({ date: Date, value: v });
  }
  const {last,prev} = lastTwo(rows);
  return { close:last, pct:pct(last,prev) };
}

// --- FRED (macro series) ---
async function fredLatest(id){
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`;
  const { data } = await axios.get(url, { timeout: 8000, headers: {'User-Agent': UA, 'Accept':'text/csv'} });
  const lines = String(data).trim().split(/\r?\n/);
  const rows = [];
  for (let i=1;i<lines.length;i++){
    const [DATE, VAL] = lines[i].split(',');
    const v = toNum(VAL);
    if (v!=null) rows.push({ date: DATE, value: v });
  }
  const {last,prev} = lastTwo(rows);
  return { close:last, pct:pct(last,prev) };
}

// --- Alpha Vantage (optional fallback via env key) ---
async function alphaDaily(symbol, key){
  if (!key) throw new Error('no alpha key');
  const url = 'https://www.alphavantage.co/query';
  const { data } = await axios.get(url, {
    timeout: 8000,
    params: { function: 'TIME_SERIES_DAILY', symbol, apikey: key, outputsize: 'compact' },
    headers: { 'User-Agent': UA, 'Accept': 'application/json' }
  });
  const series = data?.['Time Series (Daily)'] || data?.['Time Series Daily'] || {};
  const days = Object.keys(series).sort();
  if (days.length < 2) throw new Error('alpha no data');
  const last = Number(series[days[days.length-1]]['4. close']);
  const prev = Number(series[days[days.length-2]]['4. close']);
  if (!Number.isFinite(last) || !Number.isFinite(prev)) throw new Error('alpha bad value');
  return { close: last, pct: +(((last - prev) / prev) * 100).toFixed(2) };
}

// --- gold fallback chain ---
async function goldLatest(notes){
  try{ return await fredLatest('GOLDPMGBD228NLBM'); } catch{ notes.push('fred GOLDPM… failed'); }
  try{ return await fredLatest('GOLDAMGBD228NLBM'); } catch{ notes.push('fred GOLDAM… failed'); }
  try{ return await stooqDaily('gld.us'); } catch{ notes.push('stooq gld.us failed'); }
  const key = process.env.ALPHA_VANTAGE_KEY;
  if (key) {
    try { const v = await alphaDaily('GLD', key); notes.push('gold via AlphaVantage GLD'); return v; }
    catch { /* ignore */ }
  }
  return { close:null, pct:null };
}

module.exports = function mountIntl(app){
  app.get('/intl/market_snapshot', async (_req,res)=>{
    const today = new Date().toISOString().slice(0,10);
    const notes = [];

    // 指數：先 stooq 指數，失敗→ stooq ETF 代理；仍失敗→ Alpha (若有 key)
    const mainIdx  = { spx:'^spx', ndx:'^ndx', dji:'^dji', vix:'^vix', sox:'soxx.us' };
    const etfProxy = { spx:'spy.us', ndx:'qqq.us', dji:'dia.us', vix:'vixy.us', sox:'soxx.us' };
    const alphaSym = { spx:'SPY', ndx:'QQQ', dji:'DIA', vix:'VIXY', sox:'SOXX' };
    const alphaKey = process.env.ALPHA_VANTAGE_KEY;

    const idxTasks = Object.entries(mainIdx).map(async ([k,sym])=>{
      try { return [k, await stooqDaily(sym)]; }
      catch {
        notes.push(`stooq ${sym} failed`);
        // ETF proxy on stooq
        try {
          const proxy = etfProxy[k];
          const v = await stooqDaily(proxy);
          notes.push(`${k} via ETF proxy ${proxy}`);
          return [k, v];
        } catch {
          notes.push(`stooq proxy for ${k} failed`);
          // AlphaVantage as last resort (optional)
          if (alphaKey) {
            try {
              const v = await alphaDaily(alphaSym[k], alphaKey);
              notes.push(`${k} via AlphaVantage ${alphaSym[k]}`);
              return [k, v];
            } catch { /* fall through */ }
          }
          return [k, { close:null, pct:null }];
        }
      }
    });

    // 宏觀（FRED）
    const fredMap = { dxy:'DTWEXBGS', us10y:'DGS10', wti:'DCOILWTICO', brent:'DCOILBRENTEU' };
    const fredTasks = Object.entries(fredMap).map(([k,id]) =>
      fredLatest(id).then(v=>[k,v]).catch(()=>{ notes.push(`fred ${id} failed`); return [k,{close:null,pct:null}]; })
    );

    // gold 特別備援
    const goldTask = goldLatest(notes).then(v=>['gold',v]);

    const results = await Promise.allSettled([...idxTasks, ...fredTasks, goldTask]);
    const snap = { date: today, notes };
    for (const r of results){
      if (r.status === 'fulfilled'){
        const [k,v] = r.value; snap[k]=v;
      }
    }
    res.json(snap);
  });

  app.get('/intl/news_headlines', async (req,res)=>{
    const limit = Math.min(Math.max(parseInt(req.query.limit || '6',10),1),12);
    try{
      const feed = await parser.parseURL('https://feeds.a.dj.com/rss/RSSMarketsMain.xml');
      const items = (feed.items||[]).slice(0,limit).map(it=>({
        title: it.title, source: 'WSJ.com: Markets', url: it.link, published_at: it.isoDate || it.pubDate
      }));
      res.json({ items });
    }catch(e){ res.status(502).json({ ok:false, error:String(e?.message||e) }); }
  });
};
