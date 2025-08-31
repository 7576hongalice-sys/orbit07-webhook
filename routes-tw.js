// routes-tw.js — Taiwan stocks (official sources; no Yahoo)
// 1st: TWSE MIS (server-to-server OK). 2nd: FinMind dataset as fallback.
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ---- TWSE MIS: getStockInfo.jsp （可同時查多檔） --------------------
async function twseMisQuote(codes = []) {
  if (!codes.length) return [];
  // 同一檔同時嘗試 tse_ 與 otc_，回來再篩
  const channels = [];
  for (const c of codes) {
    const code = String(c).trim();
    if (!/^\d{4}$/.test(code)) continue;
    channels.push(`tse_${code}.tw`, `otc_${code}.tw`);
  }
  if (!channels.length) return [];

  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(channels.join('|'))}`;
  const { data } = await axios.get(url, {
    timeout: 10000,
    headers: {
      'User-Agent': UA,
      'Referer': 'https://mis.twse.com.tw/stock/index.jsp',
      'Accept': 'application/json'
    }
  });

  const arr = data?.msgArray || [];
  // 轉成統一欄位
  const map = new Map();
  for (const it of arr) {
    const code = it.c;                      // 代號
    const name = it.n || '';                // 名稱
    const z = Number(it.z);                 // 近成交價（收盤後仍為當日最後價）
    const y = Number(it.y);                 // 昨收
    const o = Number(it.o);                 // 開盤
    const h = Number(it.h), l = Number(it.l);
    const v = Number(it.v);                 // 量（張）
    const price = isFinite(z) ? z : (isFinite(o) ? o : null);
    const prev  = isFinite(y) ? y : null;
    const chg   = (isFinite(price) && isFinite(prev)) ? +(price - prev).toFixed(2) : null;
    const pct   = (isFinite(chg) && isFinite(prev) && prev !== 0) ? +(chg / prev * 100).toFixed(2) : null;

    // 以代號為 key；若同代號回兩筆（tse/otc），擇其有價的
    const existed = map.get(code);
    if (!existed || (price != null && existed.price == null)) {
      map.set(code, {
        code, name,
        price, prevClose: prev,
        change: chg, pct,
        open: isFinite(o) ? o : null,
        high: isFinite(h) ? h : null,
        low:  isFinite(l) ? l : null,
        volume: isFinite(v) ? v : null,
        source: 'TWSE:MIS'
      });
    }
  }
  return Array.from(map.values());
}

// ---- FinMind fallback（偶爾用；不需金鑰即可少量取用） ----------------
async function finmindLastClose(code) {
  try {
    const end = new Date();
    const yyyy = end.getFullYear();
    const mm = String(end.getMonth() + 1).padStart(2, '0');
    const dd = String(end.getDate()).padStart(2, '0');
    const start = `${yyyy - 1}-01-01`;
    const endStr = `${yyyy}-${mm}-${dd}`;
    const url = 'https://api.finmindtrade.com/api/v4/data';
    const { data } = await axios.get(url, {
      params: { dataset: 'TaiwanStockPrice', stock_id: code, start_date: start, end_date: endStr },
      timeout: 12000,
      headers: { 'User-Agent': UA }
    });
    const rows = data?.data || [];
    if (!rows.length) return null;
    const last = rows[rows.length - 1];
    return {
      code,
      name: '', // 若需名稱可配合你 routes-lists 的 symbols.json
      price: Number(last.close),
      prevClose: Number(last.close) - Number(last.change),
      change: Number(last.change),
      pct: Number(last.change) / (Number(last.close) - Number(last.change)) * 100,
      open: Number(last.open), high: Number(last.max), low: Number(last.min),
      volume: Number(last.Trading_Volume),
      source: 'FinMind'
    };
  } catch { return null; }
}

module.exports = function mountTW(app) {
  // GET /tw/quote?codes=2330,2603,0050
  app.get('/tw/quote', async (req, res) => {
    const codes = (req.query.codes || '').toString().split(',').map(s => s.trim()).filter(Boolean);
    if (!codes.length) return res.status(400).json({ error: 'codes required, e.g. ?codes=2330,2603' });

    const out = { date: new Date().toISOString().slice(0,10), notes: [], quotes: [] };

    try {
      const a = await twseMisQuote(codes);
      const got = new Set(a.map(x => x.code));
      out.quotes.push(...a);

      // 缺的用 FinMind 補
      for (const c of codes) {
        if (!got.has(c)) {
          const b = await finmindLastClose(c);
          if (b) out.quotes.push(b);
          else out.notes.push(`missing ${c}`);
        }
      }
    } catch (e) {
      out.notes.push('twseMisQuote error: ' + (e?.message || e));
      // 全數退 FinMind
      for (const c of codes) {
        const b = await finmindLastClose(c);
        if (b) out.quotes.push(b);
        else out.notes.push(`missing ${c}`);
      }
    }
    res.json(out);
  });
};
