// routes-lists.js — 追蹤清單 API（watch/add/remove/clear + 批次 + 名稱對應）
// - 以 chat_id 區分使用者
// - 預設存到 /tmp/watchlists.json（Render 會清空）；建議用 WATCH_STORE=/data/watchlists.json 並掛 Disk 到 /data
// - /lists/watch 支援 ?format=md，給「辰財」直接讀；同時提供 JSON 給程式用

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STORE = process.env.WATCH_STORE || '/tmp/watchlists.json';
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function loadStore() {
  try {
    if (fs.existsSync(STORE)) {
      const raw = fs.readFileSync(STORE, 'utf8');
      return JSON.parse(raw);
    }
  } catch {}
  return { users: {} }; // { users: { [chat_id]: { user:[], mama:[] } } }
}
function saveStore(db) {
  try {
    ensureDir(STORE);
    fs.writeFileSync(STORE, JSON.stringify(db));
    return true;
  } catch (e) {
    console.error('saveStore failed:', e.message || e);
    return false;
  }
}
function normalizeCodes(input) {
  // 支援 codes=2330,2603 或空白、換行；僅取 4~6 位數字
  const arr = String(input || '')
    .split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
    .map(s => s.replace(/[^\d]/g, ''))
    .filter(s => s.length >= 4 && s.length <= 6);
  return Array.from(new Set(arr));
}

// 取得名稱對應（TWSE MIS）
async function fetchNames(codes = []) {
  const unique = Array.from(new Set((codes || []).filter(Boolean)));
  if (!unique.length) return {};
  const channels = [];
  for (const c of unique) channels.push(`tse_${c}.tw`, `otc_${c}.tw`);
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(channels.join('|'))}`;
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': UA, 'Referer': 'https://mis.twse.com.tw/stock/index.jsp' }
    });
    const map = {};
    for (const it of (data?.msgArray || [])) {
      const code = it.c, name = it.n;
      if (code && name && !map[code]) map[code] = name;
    }
    return map;
  } catch { return {}; }
}

function mdList(title, items) {
  const lines = [`**${title}**`];
  if (!items?.length) lines.push('- （空）');
  else for (const t of items) lines.push(`- ${t}`);
  return lines.join('\n');
}

module.exports = function mountLists(app) {
  // keep-alive / 健康檢查
  app.get('/lists/ping', (_req, res) => res.json({ ok: true, store: STORE }));

  // 讀清單
  // GET /lists/watch?chat_id=8418229161&format=md|json
  app.get('/lists/watch', async (req, res) => {
    try {
      const chatId = String(req.query.chat_id || '').trim();
      const format = String(req.query.format || 'json').toLowerCase();
      if (!chatId) return res.status(400).json({ ok:false, error:'chat_id required' });

      const db = loadStore();
      const bucket = db.users[chatId] || { user: [], mama: [] };
      const codes = Array.from(new Set([...(bucket.user||[]), ...(bucket.mama||[])]));
      const nameMap = await fetchNames(codes);

      const userWithName = (bucket.user || []).map(c => nameMap[c] ? `${nameMap[c]}（${c}）` : c);
      const mamaWithName = (bucket.mama || []).map(c => nameMap[c] ? `${nameMap[c]}（${c}）` : c);

      if (format === 'md' || format === 'markdown' || format === 'text') {
        res.type('text/plain').send(
          ['以下是你的觀察股：', mdList('使用者追蹤', userWithName), '', mdList('媽媽追蹤（必分析）', mamaWithName)].join('\n')
        );
      } else {
        res.json({ ok:true, chat_id: chatId, items: { user: bucket.user || [], mama: bucket.mama || [] }, names: nameMap });
      }
    } catch (e) {
      res.status(500).json({ ok:false, error: String(e.message || e) });
    }
  });

  // 新增（支援多檔）：GET/POST /lists/add?chat_id=..&codes=2330,2603&bucket=user|mama
  async function addHandler(req, res) {
    try {
      const chatId = String(req.body.chat_id || req.query.chat_id || '').trim();
      const codes = normalizeCodes(req.body.codes || req.query.codes || req.body.code || req.query.code || '');
      const bucketName = String(req.body.bucket || req.query.bucket || 'user').toLowerCase(); // user|mama
      if (!chatId) return res.status(400).json({ ok:false, error:'chat_id required' });
      if (!codes.length) return res.status(400).json({ ok:false, error:'codes required' });
      if (!['user','mama'].includes(bucketName)) return res.status(400).json({ ok:false, error:'bucket must be user|mama' });

      const db = loadStore();
      if (!db.users[chatId]) db.users[chatId] = { user: [], mama: [] };
      const set = new Set(db.users[chatId][bucketName] || []);
      for (const c of codes) set.add(c);
      db.users[chatId][bucketName] = Array.from(set);
      saveStore(db);
      res.json({ ok:true, chat_id: chatId, bucket: bucketName, items: db.users[chatId] });
    } catch (e) {
      res.status(500).json({ ok:false, error: String(e.message || e) });
    }
  }
  app.post('/lists/add', addHandler);
  app.get('/lists/add', addHandler);

  // 移除（支援多檔）：GET/POST /lists/remove?chat_id=..&codes=2330,2603&bucket=user|mama
  async function removeHandler(req, res) {
    try {
      const chatId = String(req.body.chat_id || req.query.chat_id || '').trim();
      const codes = normalizeCodes(req.body.codes || req.query.codes || req.body.code || req.query.code || '');
      const bucketName = String(req.body.bucket || req.query.bucket || 'user').toLowerCase();
      if (!chatId) return res.status(400).json({ ok:false, error:'chat_id required' });
      if (!codes.length) return res.status(400).json({ ok:false, error:'codes required' });
      if (!['user','mama'].includes(bucketName)) return res.status(400).json({ ok:false, error:'bucket must be user|mama' });

      const db = loadStore();
      if (!db.users[chatId]) db.users[chatId] = { user: [], mama: [] };
      const arr = (db.users[chatId][bucketName] || []).filter(c => !codes.includes(c));
      db.users[chatId][bucketName] = arr;
      saveStore(db);
      res.json({ ok:true, chat_id: chatId, bucket: bucketName, items: db.users[chatId] });
    } catch (e) {
      res.status(500).json({ ok:false, error: String(e.message || e) });
    }
  }
  app.post('/lists/remove', removeHandler);
  app.get('/lists/remove', removeHandler);

  // 清空
  // GET /lists/clear?chat_id=...
  app.get('/lists/clear', (req, res) => {
    const chatId = String(req.query.chat_id || '').trim();
    if (!chatId) return res.status(400).json({ ok:false, error:'chat_id required' });
    const db = loadStore();
    db.users[chatId] = { user: [], mama: [] };
    saveStore(db);
    res.json({ ok:true, chat_id: chatId, cleared: true });
  });
};
