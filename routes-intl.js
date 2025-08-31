// routes-intl.js — International snapshot + headlines (parallel, no API keys)
const axios = require('axios');
const RSSParser = require('rss-parser');
const parser = new RSSParser();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const toNum = (x) => {
  const n = Number(String(x ?? '').trim());
  return Number.isFinite(n) ? n : null;
};
const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0)
  ? +(((a - b) / b) * 100).toFixed(2) : null;

function lastTwo(rows) {
  const vals = rows.map(r => toNum(r.value)).filter(v => Number.isFinite(v));
  if (vals.length < 2) return { last: null, prev: null };
  return { last: vals[vals.length - 1], prev: vals[vals.length - 2] };
}

// ---- Stooq (indices/VIX/ETF proxy) ----
async function stooqDaily(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const { data } = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': UA } });
  const lines = String(data).trim().split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const [Date, Open, High, Low, Close] = lines[i].split(',');
    const v = toNum(Close);
    if (v != null) out.push({ date: Date, value: v });
  }
  const { last, prev } = lastTwo(out);
  return { close: last, pct: pct(last, prev) };
}

// ---- FRED (macro series) ----
async function fredLatest(id) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`;
  const { data } = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': UA } });
  const lines = String(data).trim().split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, val] = lines[i].split(',');
    const v = toNum(val);
    if (v != null) out.push({ date, value: v });
  }
  const { last, prev } = lastTwo(out);
  return { close: last, pct: pct(last, prev) };
}

module.exports = function mountIntl(app) {
  app.get('/intl/market_snapshot', async (_req, res) => {
    const today = new Date().toISOString().slice(0,10);
    const notes = [];

    // 並行抓取（Promise.allSettled）
    const stooqMap = { spx: '^spx', ndx: '^ndx', dji: '^dji', vix: '^vix', sox: 'soxx.us' }; // SOX 用 SOXX 代理
    const fredMap  = { dxy: 'DTWEXBGS', us10y: 'DGS10', wti: 'DCOILWTICO', brent: 'DCOILBRENTEU', gold: 'GOLDAMGBD228NLBM' };

    const stooqTasks = Object.entries(stooqMap).map(([k, s]) =>
      stooqDaily(s).then(v => [k, v]).catch(() => { notes.push(`stooq ${s} failed`); return [k, { close: null, pct: null }]; })
    );
    const fredTasks = Object.entries(fredMap).map(([k, id]) =>
      fredLatest(id).then(v => [k, v]).catch(() => { notes.push(`fred ${id} failed`); return [k, { close: null, pct: null }]; })
    );

    const results = await Promise.allSettled([...stooqTasks, ...fredTasks]);
    const snapshot = { date: today, notes };
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const [k, v] = r.value;
        snapshot[k] = v;
      }
    }
    if (!snapshot.sox) notes.push('SOX via SOXX proxy');

    res.json(snapshot);
  });

  app.get('/intl/news_headlines', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '6', 10), 1), 12);
    try {
      const feed = await parser.parseURL('https://feeds.a.dj.com/rss/RSSMarketsMain.xml');
      const items = (feed.items || []).slice(0, limit).map(it => ({
        title: it.title, source: 'WSJ.com: Markets', url: it.link, published_at: it.isoDate || it.pubDate
      }));
      res.json({ items });
    } catch (e) {
      res.status(502).json({ ok:false, error: String(e?.message || e) });
    }
  });
};
