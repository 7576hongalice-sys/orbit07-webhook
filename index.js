// index.js（覆蓋版）
process.env.TZ = 'Asia/Taipei'; // 強制使用台灣時區

import express from 'express';
import fetch from 'node-fetch';
import { preOpen, noonBrief, closeWrap } from './modules/push.js';
import { priceLookup } from './modules/price_lookup.js';
import { saveForecast, compareWithClose } from './modules/forecast.js';

const app = express();
app.use(express.json());

const TOKEN = process.env.TG_BOT_TOKEN;
if (!TOKEN) console.warn('[WARN] TG_BOT_TOKEN is missing');
const API = `https://api.telegram.org/bot${TOKEN}`;

const VERSION = '2025-08-15-01';

// ⬇️ 送出底部「戀股主場」功能列
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

app.get('/healthz', (req, res) => {
  res.status(200).json({
    ok: true,
    version: VERSION,
    time: new Date().toString() // 會顯示台灣時間
  });
});

// Telegram Webhook entry
app.post('/tg', async (req, res) => {
  try {
    const upd = req.body;
    const msg = upd.message || upd.edited_message;
    if (!msg) return res.sendStatus(200);

    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    // 顯示底部功能列
    if (text === '/start' || text === '/menu' || text === '主選單') {
      await sendMenu(chatId);
      return res.sendStatus(200);
    }

    // 盤前導航按鈕觸發（新舊名稱皆支援，× 或 x 都可）
    const isPreopenBtn =
      text === '🧭 戀股主場｜盤前導航 × 操作建議' ||
      text === '🧭 戀股主場｜盤前導航 × 操作分析' || // 舊名相容
      text === '🧭 戀股主場｜盤前導航 x 操作建議';

    let reply = 'I am alive ✅';

    if (text === '/ping') reply = 'pong';

    if (isPreopenBtn) {
      const f = await preOpen();      // 戀股主場版：盤前預言 + 導航
      await saveForecast(f);          // 存給盤後對帳
      reply = f;
    }

    // 仍保留 /today 文字指令
    if (text === '/today') {
      const f = await preOpen();
      await saveForecast(f);
      reply = f;
    }

    // 午盤/盤後（按鈕或斜線指令皆可）
    if (text === '📰 午盤小結' || text === '/noon') {
      reply = await noonBrief();
    }

    if (text === '📈 盤後對帳' || text === '/close') {
      const summary = await closeWrap();            // 收盤總結
      reply = await compareWithClose(summary);      // 對帳結果
    }

    // 查價：按鈕提示 or 斜線查價
    if (text === '💲 查價') {
      reply = '請輸入：/p 代號（例：/p 2330）';
    }
    if (text.startsWith('/p ')) {
      const q = text.slice(3).trim();
      reply = await priceLookup(q);
    }

    // 預覽/發布盤前（若尚未安裝一鍵發布，先回提示）
    if (text === '🔮 預覽盤前') {
      reply = '預覽功能尚未安裝（之後可加：把你貼的素材自動排版預覽）。';
    }
    if (text === '✅ 發布盤前') {
      reply = '發布功能尚未安裝（之後可加：自動寫入 content/preopen.txt）。';
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

    // 統一送出回覆
    await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply })
    });

    res.sendStatus(200);
  } catch (e) {
    console.error('handler error:', e);
    res.sendStatus(200); // 避免 Telegram 重送爆量
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('server up on', PORT));
