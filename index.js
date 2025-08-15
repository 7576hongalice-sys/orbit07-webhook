// index.js (覆蓋版)
process.env.TZ = 'Asia/Taipei'; // 強制使用台灣時區

import express from 'express';
import fetch from 'node-fetch';
import { preOpen, noonBrief, closeWrap } from './modules/push.js';
import { priceLookup } from './modules/price_lookup.js';
import { saveForecast, compareWithClose } from './modules/forecast.js';
import { makePreopenFromRaw } from './modules/ingest.js';
import { publishToGitHub }    from './modules/publisher.js';

const app = express();
app.use(express.json());

const TOKEN = process.env.TG_BOT_TOKEN;
if (!TOKEN) console.warn('[WARN] TG_BOT_TOKEN is missing');
const API = `https://api.telegram.org/bot${TOKEN}`;

const VERSION = '2025-08-15-05'; // 便於 /healthz 檢查

// ——— 小工具 ———
const norm = (s='') => s
  .replace(/\uFF5C/g, '|')  // 全形｜ → 半形|
  .replace(/×/g, 'x')       // 乘號× → x
  .replace(/\s+/g, ' ')     // 多空白 → 一格
  .trim();

async function sendLong(chatId, text) {
  const MAX = 3800;
  let t = text || '';
  while (t.length > MAX) {
    const cut = t.lastIndexOf('\n', MAX) > 0 ? t.lastIndexOf('\n', MAX) : MAX;
    const part = t.slice(0, cut);
    await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: part })
    });
    t = t.slice(cut);
  }
  await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: t })
  });
}

function ymdLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const da = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${da}`;
}

// 最近一次貼的「素材」暫存（每個 chat 獨立）
const lastUserText = {};
const RESERVED_RAW = [
  '🧭 戀股主場｜盤前導航 × 操作建議',
  '🧭 戀股主場｜盤前導航 × 操作分析',
  '📰 午盤小結', '📈 盤後對帳', '💲 查價', '🧹 收起選單',
  '🔮 預覽盤前', '✅ 發布盤前', '/menu', '/start', '/today', '/noon', '/close'
];
const RESERVED = new Set(RESERVED_RAW.map(norm));

// ——— 主選單 ———
async function sendMenu(chatId) {
  const keyboard = [
    [{ text: '🧭 戀股主場｜盤前導航 × 操作建議' }],
    [{ text: '🔮 預覽盤前' }, { text: '✅ 發布盤前' }],
    [{ text: '📰 午盤小結' }, { text: '📈 盤後對帳' }],
    [{ text: '💲 查價' }, { text: '🧹 收起選單' }]
  ];
  await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: '〔戀股主場 · 主選單〕請選擇功能：',
      reply_markup: { keyboard, resize_keyboard: true }
    })
  });
}

// ——— 健康檢查 ———
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, version: VERSION, time: new Date().toString() });
});

// ——— Telegram Webhook ———
app.post('/tg', async (req, res) => {
  try {
    const upd = req.body;

    // 👇 新增：忽略 edited_message（例如含網址的訊息被 Telegram 重新編輯）
    if (upd.edited_message) return res.sendStatus(200);

    const msg = upd.message;
    if (!msg) return res.sendStatus(200);

    const chatId = msg.chat.id;
    const text   = (msg.text || '').trim();
    const ntext  = norm(text);

    // 記住「素材」：非斜線指令 且 不是功能鍵
    if (text && !text.startsWith('/') && !RESERVED.has(ntext)) {
      lastUserText[chatId] = text;
    }

    // 主選單
    if (ntext === '/start' || ntext === '/menu' || text === '主選單') {
      await sendMenu(chatId);
      return res.sendStatus(200);
    }

    // 盤前按鈕（容錯：｜/|、×/x、舊名）
    const isPreopenBtn =
      ntext === '🧭 戀股主場|盤前導航 x 操作建議' ||
      ntext === '🧭 戀股主場|盤前導航 x 操作分析' ||
      (ntext.includes('盤前導航') && (ntext.includes('操作建議') || ntext.includes('操作分析')));

    // /ping
    if (ntext === '/ping') {
      await sendLong(chatId, 'pong');
      return res.sendStatus(200);
    }

    // 盤前（按鈕）
    if (isPreopenBtn) {
      const f = await preOpen();
      await saveForecast(f);
      await sendLong(chatId, f);
      return res.sendStatus(200);
    }

    // 盤前（文字指令）
    if (ntext === '/today') {
      const f = await preOpen();
      await saveForecast(f);
      await sendLong(chatId, f);
      return res.sendStatus(200);
    }

    // 🔮 預覽盤前
    if (ntext === '🔮 預覽盤前' || ntext === '預覽盤前') {
      const raw = (msg.reply_to_message?.text) || lastUserText[chatId] || '';
      const preview = makePreopenFromRaw(raw || '（尚未擷取到素材）');
      await sendLong(chatId, preview);
      return res.sendStatus(200);
    }

    // ✅ 發布盤前（直接＋回覆＋最近貼的）→ 三份歸檔 + 覆蓋最新
    if (ntext === '✅ 發布盤前' || ntext.startsWith('發布盤前') || ntext === '發布盤前') {
      let raw = '';
      // 直接法：發布盤前：<素材>
      if (/^發布盤前[:：]/.test(text)) {
        raw = text.split(/[:：]/)[1]?.trim() || '';
      }
      // 回覆法
      if (!raw && msg.reply_to_message?.text) raw = msg.reply_to_message.text;
      // 最近貼的
      if (!raw) raw = lastUserText[chatId] || '';

      if (!raw) {
        await sendLong(chatId, '找不到素材 📄\n請先貼素材，或回覆素材訊息再傳：發布盤前');
        return res.sendStatus(200);
      }

      const preopen = makePreopenFromRaw(raw);
      const ymd = ymdLocal();
      try {
        await publishToGitHub(`content/raw/${ymd}.txt`, raw);                 // 原稿
        await publishToGitHub(`content/archive/preopen/${ymd}.txt`, preopen); // 成品存檔
        await publishToGitHub('content/preopen.txt', preopen);                // 最新
        try { await saveForecast(preopen); } catch {}
        await sendLong(chatId, '已發布並完成歸檔 ✅ 明早 07:20 會自動推播');
        await sendLong(chatId, preopen); // 同場預覽
      } catch (e) {
        await sendLong(chatId, `發布失敗，請檢查 GITHUB_TOKEN / GH_OWNER / GH_REPO。\n${e.message || e}`);
      }
      return res.sendStatus(200);
    }

    // 午盤
    if (ntext === '📰 午盤小結' || ntext === '/noon') {
      const m = await noonBrief();
      await sendLong(chatId, m);
      return res.sendStatus(200);
    }

    // 盤後對帳
    if (ntext === '📈 盤後對帳' || ntext === '/close') {
      const summary = await closeWrap();
      const report  = await compareWithClose(summary);
      await sendLong(chatId, report);
      return res.sendStatus(200);
    }

    // 查價提示 & /p 真查價
    if (ntext === '💲 查價') {
      await sendLong(chatId, '請輸入：/p 代號（例：/p 2330）');
      return res.sendStatus(200);
    }
    if (ntext.startsWith('/p ')) {
      const q = text.slice(3).trim();
      const ans = await priceLookup(q);
      await sendLong(chatId, ans);
      return res.sendStatus(200);
    }

    // 收起功能列
    if (ntext === '🧹 收起選單') {
      await fetch(`${API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '已收起選單。輸入 /menu 可再叫出來。',
          reply_markup: { remove_keyboard: true }
        })
      });
      return res.sendStatus(200);
    }

    // 預設回覆（看得到代表沒匹配到任何指令）
    await sendLong(chatId, 'I am alive ✅');
    res.sendStatus(200);
  } catch (e) {
    console.error('handler error:', e);
    res.sendStatus(200); // 避免 Telegram 重送爆量
  }
});

// ——— 啟動 ———
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('server up on', PORT));
