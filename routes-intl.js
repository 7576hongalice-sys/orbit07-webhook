// routes-intl.js — International snapshot & headlines (keyless sources)
// 來源：TradingEconomics guest:guest（指數、商品、債券、美元）＋ 白名單 RSS
const axios = require('axios');
const Parser = require('rss-parser');

const DEFAULT_NEWS = [
  'https://www.reuters.com/markets/rss',
  'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',
  'https://apnews.com/hub/ap-top-news?utm_source=rss'
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ---- TradingEconomics helpers (no key needed: guest:guest) ----
async function teGet(path) {
  const url = `https://api.tradingeconomics.com${path}${path.includes('?') ? '&' : '?'}c=guest:guest&format=json`;
  const { data } = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': UA, Accept: 'application/json' } });
  return Array.isArray(data) ? data : [];
}
function pickByName(rows, keywords) {
  const ks = keywords.map(k => k.toLowerCase());
  return rows.find(r => {
    const name = (r.name || r.symbol || r.ticker || '').toLowerCase();
    return ks.every(k => name.includes(k));
  }) || null;
}
function toField(row) {
  if (!row) return null;
  // TradingEconomics 常見欄位：last / change / changesPercentage
  const close = Number(row.last ?? row.close ?? row.price ?? row.value);
  const pct   = Number(row.changesPercentage ?? row.change_percent ?? row.changepct ?? row.chg_pct);
  return {
    close: isFinite(close) ? close : null,
    pct: isFinite(pct) ? pct : null,
    source: 'TE'
  };
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

    try {
      // 指數
      const indices = await teGet('/markets/indices');
      // 商品
      const comm    = await teGet('/markets/commodities');
      // 債券（收益率）
      const bonds   = await teGet('/markets/bonds');
      // 外匯／美元指數
      const fx      = await teGet('/markets/forex');

      // S&P 500 / Nasdaq 100 / Dow Jones / SOX / VIX
      out.spx = toField(pickByName(indices, ['s&p', '500'])) || toField(pickByName(indices, ['spx']));
      out.ndx = toField(pickByName(indices, ['nasdaq', '100'])) || toField(pickByName(indices, ['nasdaq']));
      out.dji = toField(pickByName(indices, ['dow', 'jones']))  || toField(pickByName(indices, ['dow']));
      // 半導體指數（名稱在 TE 可能是 Philadelphia/PHLX Semiconductor）
      out.sox = toField(pickByName(indices, ['semiconductor'])) || null;
      // VIX（Volatility）
      out.vix = toField(pickByName(indices, ['volatility', 'vix'])) || null;

      // 美元指數（Dollar Index / US Dollar Index）
      out.dxy = toField(pickByName(indices, ['dollar', 'index'])) ||
                toField(pickByName(fx, ['dollar', 'index'])) || null;

      // 10Y
      out.us10y = toField(pickByName(bonds, ['10', 'year'])) ||
                  toField(pickByName(bonds, ['ten', 'year'])) || null;

      // 商品
      out.wti   = toField(pickByName(comm, ['crude', 'oil', 'wti'])) || null;
      out.brent = toField(pickByName(comm, ['brent'])) || null;
      out.gold  = toField(pickByName(comm, ['gold']))  || null;

      // 註記缺項
      ['spx','ndx','dji','sox','vix','dxy','us10y','wti','brent','gold'].forEach(k => {
        if (!out[k]) out.notes.push(`missing ${k}`);
      });
    } catch (e) {
      out.notes.push('tradingeconomics fetch failed: ' + (e?.message || e));
    }

    res.json(out);
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
      } catch { /* 單源失敗略過 */ }
      if (items.length >= limit) break;
    }
    res.json({ items: items.slice(0, limit) });
  });
};
