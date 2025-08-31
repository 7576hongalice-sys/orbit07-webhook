// routes-intl.js — International snapshot + headlines (no API keys)
// Sources:
//   - Indices/VIX: Stooq CSV (free, legal): https://stooq.com
//   - Macro (rates/FX/commodities): FRED CSV (free): https://fred.stlouisfed.org
//   - Headlines: WSJ Markets RSS (whitelisted)
//
// Endpoints:
//   GET /intl/market_snapshot
//   GET /intl/news_headlines?limit=5
//
const axios = require('axios');
const RSSParser = require('rss-parser');
const parser = new RSSParser();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ---------- utilities ----------
const toNum = (x) => {
  if (x == null) return null;
  const n = Number(String(x).trim());
  return Number.isFinite(n) ? n : null;
};
function lastTwoNumbers(rows) {
  // rows: array of {date, value} sorted asc or desc; pick last two numeric
  const vals = rows
    .map(r => toNum(r.value))
    .filter(v => Number.isFinite(v));
  if (vals.length < 2) return { last: null, prev: null };
  return { last: vals[vals.length - 1], prev: vals[vals.length - 2] };
}
const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0)
  ? +(((a - b) / b) * 100).toFixed(2)
  : null;

// ---------- Stooq: daily CSV for indices/VIX/ETFs ----------
async function stooqDaily(symbol) {
  // CSV header: Date,Open,High,Low,Close,Volume
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const { data } = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': UA } });
  const lines = String(data).trim().split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const [Date, Open, High, Low, Close/*, Volume*/] = lines[i].split(',');
    const v = toNum(Close);
    if (v != null) out.push({ date: Date, value: v });
  }
  const { last, prev } = lastTwoNumbers(out);
  return { close: last, pct: pct(last, prev) };
}

// ---------- FRED: CSV without API key ----------
async function fredLatest(seriesId) {
  // Example: https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const { data } = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': UA } });
  const lines = String(data).trim().split(/\r?\n/);
  // header: "DATE,<ID>"
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, val] = lines[i].split(',');
    const v = toNum(val);
    if (v != null) out.push({ date, value: v });
  }
  const { last, prev } = lastTwoNumbers(out);
  return { close: last, pct: pct(last, prev) };
}

// ---------- snapshot route ----------
module.exports = function mountIntl(app) {
  app.get('/intl/market_snapshot', async (_req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const notes = [];

    // Stooq indices (免 key)
    // 指數：^spx, ^ndx, ^dji, ^vix；SOX 沒有官方值 → 用 SOXX ETF 作為 proxy
    let spx, ndx, dji, vix, sox;
    try { spx = await stooqDaily('^spx'); } catch { notes.push('stooq ^spx failed'); spx = { close: null, pct: null }; }
    try { ndx = await stooqDaily('^ndx'); } catch { notes.push('stooq ^ndx failed'); ndx = { close: null, pct: null }; }
    try { dji = await stooqDaily('^dji'); } catch { notes.push('stooq ^dji failed'); dji = { close: null, pct: null }; }
    try { vix = await stooqDaily('^vix'); } catch { notes.push('stooq ^vix failed'); vix = { close: null, pct: null }; }
    try { sox = await stooqDaily('soxx.us'); notes.push('SOX via SOXX proxy'); }
    catch { notes.push('stooq soxx.us failed'); sox = { close: null, pct: null }; }

    // FRED series (免 key)
    // 美元指數用 DTWEXBGS（Broad Dollar Index, daily）替代 DXY
    // 10年期殖利率 DGS10，原油/布蘭特/黃金用官方系列
    let dxy, us10y, wti, brent, gold;
    try { dxy   = await fredLatest('DTWEXBGS'); } catch { notes.push('fred DTWEXBGS failed'); dxy = { close: null, pct: null }; }
    try { us10y = await fredLatest('DGS10');     } catch { notes.push('fred DGS10 failed');     us10y = { close: null, pct: null }; }
    try { wti   = await fredLatest('DCOILWTICO');} catch { notes.push('fred DCOILWTICO failed'); wti = { close: null, pct: null }; }
    try { brent = await fredLatest('DCOILBRENTEU'); } catch { notes.push('fred DCOILBRENTEU failed'); brent = { close: null, pct: null }; }
    try { gold  = await fredLatest('GOLDAMGBD228NLBM'); } catch { notes.push('fred GOLDAMGBD228NLBM failed'); gold = { close: null, pct: null }; }

    res.json({
      date: today,
      notes,
      spx, ndx, dji, sox, vix,
      dxy, us10y, wti, brent, gold
    });
  });

  // 簡易白名單新聞（WSJ Markets RSS）
  app.get('/intl/news_headlines', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '6', 10), 1), 12);
    try {
      const feed = await parser.parseURL('https://feeds.a.dj.com/rss/RSSMarketsMain.xml');
      const items = (feed.items || []).slice(0, limit).map(it => ({
        title: it.title,
        source: 'WSJ.com: Markets',
        url: it.link,
        published_at: it.isoDate || it.pubDate
      }));
      res.json({ items });
    } catch (e) {
      res.status(502).json({ ok:false, error: String(e?.message || e) });
    }
  });
};
