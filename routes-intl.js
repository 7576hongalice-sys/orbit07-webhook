// routes-intl.js — International snapshot & headlines (legal-only)
const axios = require('axios');
const Parser = require('rss-parser');

// 白名單（可用 ENV 覆蓋）：Reuters / WSJ / AP
const DEFAULT_NEWS = [
  'https://www.reuters.com/markets/rss',
  'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',
  'https://apnews.com/hub/ap-top-news?utm_source=rss'
];

module.exports = function mountIntl(app) {
  const NEWS_RSS_SOURCES = (process.env.NEWS_RSS_SOURCES || DEFAULT_NEWS.join(','))
    .split(',').map(s => s.trim()).filter(Boolean);

  // GET /intl/market_snapshot
  app.get('/intl/market_snapshot', async (_req, res) => {
    const symbols = ['^GSPC','^IXIC','^DJI','^SOX','^VIX','DX-Y.NYB','DXY','^TNX','CL=F','BZ=F','GC=F'];
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`;
    const out = { date: new Date().toISOString().slice(0,10), notes: [], spx:null, ndx:null, dji:null, sox:null, vix:null, dxy:null, us10y:null, wti:null, brent:null, gold:null };
    try {
      const { data } = await axios.get(url, { timeout: 8000 });
      const qs = data?.quoteResponse?.result || [];
      const pick = s => qs.find(q => q.symbol === s) || null;
      const set  = (k, q) => { if (q) out[k] = { close: q.regularMarketPrice, pct: q.regularMarketChangePercent }; };

      set('spx',  pick('^GSPC')); set('ndx',  pick('^IXIC')); set('dji',  pick('^DJI')); set('sox',  pick('^SOX'));
      set('vix',  pick('^VIX'));  set('dxy',  pick('DX-Y.NYB') || pick('DXY'));
      set('wti',  pick('CL=F'));  set('brent',pick('BZ=F'));  set('gold', pick('GC=F'));

      const tnx = pick('^TNX');
      if (tnx && typeof tnx.regularMarketPrice === 'number') out.us10y = { close: Number(tnx.regularMarketPrice)/10 };
    } catch (e) {
      out.notes.push('quote fetch failed: ' + (e?.message || e));
    }
    res.json(out);
  });

  // GET /intl/news_headlines?limit=5  （只抓白名單 RSS）
  app.get('/intl/news_headlines', async (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit || 5), 20));
    const items = [];
    const parser = new Parser({ timeout: 8000, headers: { 'User-Agent': 'orbit07-intl/1.0' } });

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
      } catch { /* 單源失敗就略過 */ }
      if (items.length >= limit) break;
    }
    res.json({ items: items.slice(0, limit) });
  });
};
