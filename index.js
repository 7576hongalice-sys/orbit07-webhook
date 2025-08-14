process.env.TZ = 'Asia/Taipei'; // 強制使用台灣時區

import express from 'express';
import fetch from 'node-fetch';
import { preOpen, noonBrief, closeWrap } from './modules/push.js';
import { priceLookup } from './modules/price_lookup.js';
import { saveForecast, compareWithClose } from './modules/forecast.js';
import { makePreopenFromRaw } from './modules/ingest.js';
import { publishToGitHub } from './modules/publisher.js';

const app = express();
app.use(express.json());

const TOKEN = process.env.TG_BOT_TOKEN;
if (!TOKEN) console.warn('[WARN] TG_BOT_TOKEN is missing');
const API = `https://api.telegram.org/bot${TOKEN}`;

const VERSION = '2025-08-15-02';

// 送出底部「戀股主場」功能列
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

// 長文分段（避免超過 Telegram 4096 字）
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

// 最近一次貼的「素材」暫存（每個 chat 各自獨立）
const lastUserText = {};
const RESERVED = new Set([
  '🧭 戀股主場｜盤前導航 × 操作建議',
  '🧭 戀股主場｜盤前導航 × 操作分析',
  '📰 午盤小結',
  '📈 盤後對帳',
  '💲 查價',
  '🧹 收起選單',
  '🔮 預覽盤前',
  '✅ 發布盤前',
  '/menu', '/start', '/today', '/noon', '/close'
]);

function ymdLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2,'0');
  const da = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${da}`;
}

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, version: VERSION, time: new Date().toString() });
});

// Telegram Webhook entry
app.post('/tg', async (req, res) => {
  try {
    const upd = req.body;
    const msg = upd.message || upd.edited_message;
    if (!msg) return res.sendStatus(200);

    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    // 記住非指令且非功能鍵的「素材」
    if (text && !text.startsWith('/') && !RESERVED.has(text)) {
      lastUserText[chatId] = text;
    }

    // 主選單
    if (text === '/start' || text === '/menu' || text === '主選單') {
      await sendMenu(chatId);
      return res.sendStatus(200);
    }

    // 盤前按鈕（新舊名稱都支援，× 或 x 皆可）
    const isPreopenBtn =
      text === '🧭 戀股主場｜盤前導航 × 操作建議' ||
      text === '🧭 戀股主場｜盤前導航 × 操作分析' ||
      text === '🧭 戀股主場｜盤前導航 x 操作建議';

    // /ping
    if (text === '/ping') {
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

    // 盤前（/today 也保留）
    if (text === '/today') {
      const f = await preOpen();
      await saveForecast(f);
      await sendLong(chatId, f);
      return res.sendStatus(200);
    }

    // 🔮 預覽盤前
    if (text === '🔮 預覽盤前' || text === '預覽盤前') {
      const raw = (msg.reply_to_message?.text) || lastUserText[chatId] || '';
      const preview = makePreopenFromRaw(raw || '（尚未擷取到素材）');
      await sendLong(chatId, preview);
      return res.sendStatus(200);
    }

    // ✅ 發布盤前（支援：直接＋回覆＋冒號內文）
    if (text === '✅ 發布盤前' || text.startsWith('發布盤前') || text === '發布盤前') {
      let raw = '';
      // 直接法：發布盤前：<素材>
      if (/^發布盤前[:：]/.test(text)) {
        raw = text.split(/[:：]/)[1]?.trim() || '';
      }
      // 回覆法：回覆某則素材訊息再傳「發布盤前」
      if (!raw && msg.reply_to_message?.text) raw = msg.reply_to_message.text;
      // 最近貼的素材
      if (!raw) raw = lastUserText[chatId] || '';

      if (!raw) {
        await sendLong(chatId, '找不到素材 📄\n請先貼素材，或回覆素材訊息再傳：發布盤前');
        return res.sendStatus(200);
      }

      const preopen = makePreopenFromRaw(raw);
      const ymd = ymdLocal();

      try {
        // 三份保存：原稿、成品存檔、最新
        await publishToGitHub(`content/raw/${ymd}.txt`, raw);
        await publishToGitHub(`content/archive/preopen/${ymd}.txt`, preopen);
        await publishToGitHub('content/preopen.txt', preopen);

        // 存一份給盤後對帳
        try { await saveForecast(preopen); } catch {}

        await sendLong(chatId, '已發布並完成歸檔 ✅ 明早 07:20 會自動推播');
        await sendLong(chatId, preopen); // 同場預覽成品
        return res.sendStatus(200);
      } catch (e) {
        await sendLong(chatId, `發布失敗，請檢查 GITHUB_TOKEN / GH_OWNER / GH_REPO 設定。\n${e.message || e}`);
        return res.sendStatus(200);
      }
    }

    // 午盤
    if (text === '📰 午盤小結' || text === '/noon') {
      const m = await noonBrief();
      await sendLong(chatId, m);
      return res.sendStatus(200);
    }

    // 盤後對帳
    if (text === '📈 盤後對帳' || text === '/close') {
      const summary = await closeWrap();
      const report = await compareWithClose(summary);
      await sendLong(chatId, report);
      return res.sendStatus(200);
    }

    // 查價提示 & /p 真查價
    if (text === '💲 查價') {
      await sendLong(chatId, '請輸入：/p 代號（例：/p 2330）');
      return res.sendStatus(200);
    }
    if (text.startsWith('/p ')) {
      const q = text.slice(3).trim();
      const ans = await priceLookup(q);
      await sendLong(chatId, ans);
      return res.sendStatus(200);
    }

    // 收起功能列
    if (text === '🧹 收起選單') {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('server up on', PORT));
