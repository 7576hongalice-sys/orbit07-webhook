// routes-intl.js — International snapshot & headlines (legal-only, with fallbacks)
const axios = require('axios');
const Parser = require('rss-parser');

const DEFAULT_NEWS = [
  'https://www.reuters.com/markets/rss',
  'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',
  'https://apnews.com/hub/ap-top-news?utm_source=rss'
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function yahooQuote(symbols) {
  // 先試 query2，再試 query1
  const urls = [
    `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`,
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const { data } = await axios.get(url, { timeout: 9000, headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      return data?.quoteResponse?.result || [];
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('yahooQuote failed');
}

async function fred10Y() {
  // 用 FRED 更權威；沒 key 也先嘗試（某些區域仍可取到），失敗就回 null
  const key = process.env.FRED_KEY || '';
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&sort_order=desc&limit=1${key ? `&api_key=${key}` : ''}&file_type=json`;
  try {
    const { data } = await axios.get(url, { timeout: 9000, headers: { 'User-Agent': UA } });
    const v = data?.observations?.[0]?.value;
    const val = v && v !== '.' ? Number(v) : null;
    return val ? { close: val } : null;
  } catch { return null; }
}

module.exports = function mountIntl(app) {
  const NEWS_RSS_SOURCES = (process.env.NEWS_RSS_SOURCES || DEFAULT_NEWS.join(','))
    .split(',').map(s => s.trim()).filter(Boolean);

  // GET /intl/market_snapshot
  app.get('/intl/market_snapshot', async (_req, res) => {
    const out = {
      date: new Date().toISOString().slice(0,10),
      notes: [],
      spx:null, ndx:null, dji:null, sox:null, vix:null, dxy:null, us10y:null, wti:null, brent:null, gold:null
    };

    // 第一層：指數/指標原生代碼
    const primary = ['^GSPC','^IXIC','^DJI','^SOX','^VIX','DX-Y.NYB','DXY','^TNX','CL=F','BZ=F','GC=F'];
    // 第二層：ETF 代理（取價＆漲跌幅）：SPX→SPY、NDX→QQQ、DJI→DIA、SOX→SOXX、DXY→UUP
    const proxyMap = { spx:'SPY', ndx:'QQQ', dji:'DIA', sox:'SOXX', dxy:'UUP', gold:'GLD' };

    function setField(obj, key, q) {
      if (!q) return;
      obj[key] = {
        close: q.regularMarketPrice ?? null,
        pct: q.regularMarketChangePercent ?? null,
        symbol: q.symbol
      };
    }

    try {
      // 取 primary
      const qs = await yahooQuote(primary);
      const pick = s => qs.find(q => q.symbol === s) || null;

      setField(out, 'spx',  pick('^GSPC'));
      setField(out, 'ndx',  pick('^IXIC'));
      setField(out, 'dji',  pick('^DJI'));
      setField(out, 'sox',  pick('^SOX'));
      setField(out, 'vix',  pick('^VIX'));
      setField(out, 'dxy',  pick('DX-Y.NYB') || pick('DXY'));
      setField(out, 'wti',  pick('CL=F'));
      setField(out, 'brent',pick('BZ=F'));
      setField(out, 'gold', pick('GC=F'));

      // TNX（*10 = 基點）；轉成殖利率 %
      const tnx = pick('^TNX');
      if (tnx && typeof tnx.regularMarketPrice === 'number') {
        out.us10y = { close: Number(tnx.regularMarketPrice)/10, symbol: '^TNX' };
      }
    } catch (e) {
      out.notes.push('primary yahooQuote failed: ' + (e?.message || e));
    }

    // 若 primary 有缺，再用 ETF 代理補齊
    try {
      const need = [];
      if (!out.spx)  need.push(proxyMap.spx);
      if (!out.ndx)  need.push(proxyMap.ndx);
      if (!out.dji)  need.push(proxyMap.dji);
      if (!out.sox)  need.push(proxyMap.sox);
      if (!out.dxy)  need.push(proxyMap.dxy);
      if (!out.gold) need.push(proxyMap.gold);
      if (need.length) {
        const qs2 = await yahooQuote(need);
        const pick2 = s => qs2.find(q => q.symbol === s) || null;
        if (!out.spx)  setField(out, 'spx',  pick2(proxyMap.spx));
        if (!out.ndx)  setField(out, 'ndx',  pick2(proxyMap.ndx));
        if (!out.dji)  setField(out, 'dji',  pick2(proxyMap.dji));
        if (!out.sox)  setField(out, 'sox',  pick2(proxyMap.sox));
        if (!out.dxy)  setField(out, 'dxy',  pick2(proxyMap.dxy));
        if (!out.gold) setField(out, 'gold', pick2(proxyMap.gold));
        out.notes.push('filled by ETF proxies where needed');
      }
    } catch (e) {
      out.notes.push('proxy yahooQuote failed: ' + (e?.message || e));
    }

    // US10Y 再補 FRED（若前面沒拿到）
    if (!out.us10y) {
      const fred = await fred10Y();
      if (fred) { out.us10y = fred; out.us10y.source = 'FRED:DGS10'; }
    }

    return res.json(out);
  });

  // GET /intl/news_headlines?limit=5
  app.get('/intl/news_headlines', async (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit || 5), 20));
    const items = [];
    const parser = new Parser({ timeout: 8000, headers: { 'User-Agent': UA } });

    for (const feed of NEWS_RSS_SOURCES) {
      try {
        const f = await parser.parseURL(feed);
        for (const it of f.items || []) {
          items.push({
            title: it.title || '',
            source: f.title || 'news',
            url: it.link || '',
            published_at: it.isoDate || it.pubDate || ''
          });
          if (items.length >= limit) break;
        }
      } catch { /* ignore single-source failure */ }
      if (items.length >= limit) break;
    }
    res.json({ items: items.slice(0, limit) });
  });
};
