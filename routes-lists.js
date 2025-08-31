// routes-lists.js — 追蹤清單 API（含 /lists/watch、/lists/add、/lists/remove…）
// - 以 chat_id 區分使用者（可從 Telegram /id 取得）
// - 暫存到檔案（預設 /tmp/watchlists.json；可用環境變數 WATCH_STORE 覆寫）
// - /lists/watch 支援 ?format=md 回 Markdown，給辰財直接讀

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STORE = process.env.WATCH_STORE || '/tmp/watchlists.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

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
  } catch (e) {
    console.error('saveStore failed:', e.message || e);
  }
}
function normalizeCode(s) {
  const m = String(s || '').match(/\d{4}/);
  return m ? m[0] : null;
}

async function fetchNamesMap(codes = []) {
  // 向 TWSE MIS 取名稱（同時嘗試 tse_/otc_）
  const unique = Array.from(new Set(codes.filter(Boolean)));
  if (!unique.length) return {};
  const channels = [];
  for (const c of unique) channels.push(`tse_${c}.tw`, `otc_${c}.tw`);
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(channels.join('|'))}`;
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': UA, 'Referer': 'https://mis.twse.com.tw/stock/index.jsp' }
    });
    const arr = data?.msgArray || [];
    const out = {};
    for (const it of arr) {
      const code = it.c;
      const name = it.n || '';
      if (code && name && !out[code]) out[code] = name;
    }
    return out;
  } catch {
    return {};
  }
}

function mdList(title, items) {
  const lines = [`**${title}**`];
  if (!items?.length) {
    lines.push('- （空）');
  } else {
    for (const t of items) lines.push(`- ${t}`);
  }
  return lines.join('\n');
}

module.exports = function mountLists(app) {
  // 健康檢查（給 keep-alive）
  app.get('/lists/ping', (_req, res) => {
    res.json({ ok: true, store: STORE });
  });

  // 列出追蹤清單
  // GET /lists/watch?chat_id=8418229161&format=md
  app.get('/lists/watch', async (req, res) => {
    const chatId = (req.query.chat_id || '').toString().trim();
    const format = (req.query.format || 'json').toString().toLowerCase();

    if (!chatId) {
      return res.status(400).json({ ok: false, error: 'chat_id required' });
    }

    const db = loadStore();
    const bucket = db.users[chatId] || { user: [], mama: [] };

    // 取名稱（可失敗，失敗就只顯示代號）
    const codes = Array.from(new Set([...(bucket.user||[]), ...(bucket.mama||[])]));
    const nameMap = await fetchNamesMap(codes);

    const userWithName = (bucket.user || []).map(c => nameMap[c] ? `${nameMap[c]}（${c}）` : c);
    const mamaWithName = (bucket.mama || []).map(c => nameMap[c] ? `${nameMap[c]}（${c}）` : c);

    if (format === 'md' || format === 'markdown' || format === 'text') {
      const parts = [
        '以下是你的觀察股：',
        mdList('使用者追蹤', userWithName),
        '',
        mdList('媽媽追蹤（必分析）', mamaWithName)
      ];
      res.type('text/plain').send(parts.join('\n'));
    } else {
      res.json({
        ok: true,
        chat_id: chatId,
        items: {
          user: bucket.user || [],
          mama: bucket.mama || []
        },
        names: nameMap
      });
    }
  });

  // 新增（便利 GET 版）
  // GET /lists/add?chat_id=8418229161&code=2330&bucket=user
  app.get('/lists/add', (req, res) => {
    const chatId = (req.query.chat_id || '').toString().trim();
    const code = normalizeCode(req.query.code);
    const bucketName = (req.query.bucket || 'user').toString().toLowerCase(); // user | mama
    if (!chatId || !code) return res.status(400).json({ ok: false, error: 'chat_id & code required' });
    if (!['user', 'mama'].includes(bucketName)) return res.status(400).json({ ok: false, error: 'bucket must be user|mama' });

    const db = loadStore();
    if (!db.users[chatId]) db.users[chatId] = { user: [], mama: [] };
    const arr = db.users[chatId][bucketName];
    if (!arr.includes(code)) arr.push(code);
    saveStore(db);

    res.json({ ok: true, chat_id: chatId, bucket: bucketName, added: code, items: db.users[chatId] });
  });

  // 移除（便利 GET 版）
  // GET /lists/remove?chat_id=8418229161&code=2330&bucket=user
  app.get('/lists/remove', (req, res) => {
    const chatId = (req.query.chat_id || '').toString().trim();
    const code = normalizeCode(req.query.code);
    const bucketName = (req.query.bucket || 'user').toString().toLowerCase();
    if (!chatId || !code) return res.status(400).json({ ok: false, error: 'chat_id & code required' });
    if (!['user', 'mama'].includes(bucketName)) return res.status(400).json({ ok: false, error: 'bucket must be user|mama' });

    const db = loadStore();
    if (!db.users[chatId]) db.users[chatId] = { user: [], mama: [] };
    db.users[chatId][bucketName] = (db.users[chatId][bucketName] || []).filter(c => c !== code);
    saveStore(db);

    res.json({ ok: true, chat_id: chatId, bucket: bucketName, removed: code, items: db.users[chatId] });
  });

  // 清空
  // GET /lists/clear?chat_id=8418229161
  app.get('/lists/clear', (req, res) => {
    const chatId = (req.query.chat_id || '').toString().trim();
    if (!chatId) return res.status(400).json({ ok: false, error: 'chat_id required' });
    const db = loadStore();
    db.users[chatId] = { user: [], mama: [] };
    saveStore(db);
    res.json({ ok: true, chat_id: chatId, cleared: true });
  });
};
