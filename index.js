// index.js — ORBIT-07 webhook/push server（覆蓋版）
// Node >= 18 (全域 fetch 可用)；若要本機 dotenv，取消下行註解：
// require('dotenv').config();

process.env.TZ = 'Asia/Taipei'; // 強制台灣時區，避免排程時間跑掉

const express = require('express');
const axios   = require('axios');

// ───────────────────────────── Env ─────────────────────────────
const PORT           = process.env.PORT || 3000;
const TG_BOT_TOKEN   = process.env.TG_BOT_TOKEN;       // 你的 Telegram Bot Token
const CHAT_ID        = process.env.CHAT_ID;            // 你的私人 chat_id（正數）
const GROUP_CHAT_ID  = process.env.GROUP_CHAT_ID;      // 群組 chat_id（負數，-100 開頭）
const CRON_KEY       = process.env.CRON_KEY || '';     // /cron/*、/pub 驗證用
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';// 可選，用於 /webhook 驗證
const PARSE_MODE     = process.env.PARSE_MODE || 'Markdown';

if (!TG_BOT_TOKEN)  console.warn('[WARN] TG_BOT_TOKEN 未設定');
if (!CHAT_ID)       console.warn('[WARN] CHAT_ID 未設定（私人推播可能失敗）');
if (!GROUP_CHAT_ID) console.warn('[WARN] GROUP_CHAT_ID 未設定（群組推播會被擋）');

const API = `https://api.telegram.org/bot${TG_BOT_TOKEN}`;

// ───────────────────────────── App ─────────────────────────────
const app = express();
app.use(express.json());

// ─────────────────────────── Utilities ─────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function verifyKey(req, res) {
  // 允許在本地或未設 CRON_KEY 時略過，但雲端正式請務必設置
  if (!CRON_KEY) return true;
  const h = (req.headers['x-webhook-key'] || req.headers['x-cron-key'] || '').trim();
  if (h !== CRON_KEY) {
    res.status(401).json({ ok: false, error: 'invalid x-webhook-key' });
    return false;
  }
  return true;
}

async function sendTG(text, chatId, parseMode = PARSE_MODE) {
  if (!TG_BOT_TOKEN) throw new Error('TG_BOT_TOKEN not set');
  if (!chatId)       throw new Error('chat_id is required');

  const url  = `${API}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  };

  try {
    const { data } = await axios.post(url, body, { timeout: 25000 });
    return data;
  } catch (e) {
    // 可能是 Markdown 格式錯，退回純文字再試一次
    try {
      const { data } = await axios.post(url, { ...body, parse_mode: undefined }, { timeout: 25000 });
      return data;
    } catch (e2) {
      const detail = e2?.response?.data || e?.response?.data || e2?.message || e?.message;
      console.error('sendTG failed:', typeof detail === 'string' ? detail : JSON.stringify(detail));
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
  }
}

// 429/5xx 等退避重試
async function sendWithRetry(text, chatId, parseMode = PARSE_MODE) {
  const backoffs = [0, 1000, 2000, 4000, 8000]; // 最多 5 次，總等待 ~15s
  let lastErr;
  for (const ms of backoffs) {
    if (ms) await sleep(ms);
    try {
      return await sendTG(text, chatId, parseMode);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ──────────────────────────── Routes ───────────────────────────

// 健康檢查：也會檢視 env 是否齊全
app.get('/healthz', async (req, res) => {
  res.json({
    ok: true,
    env: {
      PORT,
      TG_BOT_TOKEN: !!TG_BOT_TOKEN,
      CHAT_ID: !!CHAT_ID,
      GROUP_CHAT_ID: !!GROUP_CHAT_ID,
      CRON_KEY: !!CRON_KEY,
      WEBHOOK_SECRET: !!WEBHOOK_SECRET,
    },
    time: new Date().toISOString(),
  });
});

// 手動推播（預設推群組）。Header 需帶 x-webhook-key: <CRON_KEY>
/**
 * body:
 * {
 *   "text": "訊息",
 *   "target": "group" | "me" | "raw",
 *   "chat_id": "<可選，當 target=raw 時使用>",
 *   "mode": "Markdown" | "HTML" | "plain"
 * }
 */
app.post('/pub', async (req, res) => {
  if (!verifyKey(req, res)) return;
  try {
    const { text, target = 'group', chat_id, mode } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });

    let toChatId;
    if (target === 'me') {
      toChatId = CHAT_ID;
      if (!toChatId) return res.status(400).json({ ok: false, error: 'CHAT_ID missing' });
    } else if (target === 'raw') {
      toChatId = chat_id;
      if (!toChatId) return res.status(400).json({ ok: false, error: 'chat_id required when target=raw' });
    } else {
      // group
      toChatId = GROUP_CHAT_ID;
      if (!toChatId) return res.status(400).json({ ok: false, error: 'GROUP_CHAT_ID missing' });
    }

    const resp = await sendWithRetry(text, toChatId, mode === 'plain' ? undefined : (mode || PARSE_MODE));
    res.json({ ok: true, target, chat_id: toChatId, result: resp });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// 範例：早安推播（群組）。Header 要帶金鑰
app.post('/cron/morning', async (req, res) => {
  if (!verifyKey(req, res)) return;
  try {
    if (!GROUP_CHAT_ID) return res.status(400).json({ ok: false, error: 'GROUP_CHAT_ID missing' });
    const text = [
      '🌅 早安導航',
      '- 市場重點：請見今日盤前摘要',
      '- 風險提示：控制部位、嚴守停損',
      `時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`
    ].join('\n');
    const resp = await sendWithRetry(text, GROUP_CHAT_ID);
    res.json({ ok: true, result: resp });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// （可選）Telegram webhook 端點：用於收訊息或日後擴充
app.post('/webhook', async (req, res) => {
  try {
    // 若你要驗證來源，可帶 query ?secret=WEBHOOK_SECRET
    if (WEBHOOK_SECRET) {
      const key = (req.query?.secret || '').toString();
      if (key !== WEBHOOK_SECRET) return res.status(401).json({ ok: false, error: 'invalid secret' });
    }
    const update = req.body || {};
    // 簡單回覆（回到私人視窗），確認 webhook 有在跑
    const msg = update?.message?.text || '(no text)';
    if (CHAT_ID) {
      await sendWithRetry(`📩 webhook 收到：${msg}`, CHAT_ID);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ──────────────────────────── Debug ────────────────────────────
// 便利診斷：查看 chat 資訊
app.get('/debug/getChat', async (req, res) => {
  try {
    const chatId = req.query.chat_id || GROUP_CHAT_ID || CHAT_ID;
    if (!chatId) return res.status(400).json({ ok: false, error: 'chat_id required' });
    const { data } = await axios.get(`${API}/getChat?chat_id=${encodeURIComponent(chatId)}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.response?.data || String(err.message || err) });
  }
});

// 便利診斷：查看 bot 在群組的身份
app.get('/debug/getChatMember', async (req, res) => {
  try {
    // 先查 bot 自己的 user_id
    const me = await axios.get(`${API}/getMe`);
    const botUserId = me?.data?.result?.id;
    const chatId = req.query.chat_id || GROUP_CHAT_ID;
    if (!chatId) return res.status(400).json({ ok: false, error: 'GROUP_CHAT_ID required' });
    const { data } = await axios.get(`${API}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${botUserId}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.response?.data || String(err.message || err) });
  }
});

// ───────────────────────────── Start ───────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server started on :${PORT}`);
});
