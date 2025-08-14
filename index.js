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

const VERSION = '2025-08-14-01';

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, version: VERSION });
});

// Telegram Webhook entry
app.post('/tg', async (req, res) => {
  try {
    const upd = req.body;
    const msg = upd.message || upd.edited_message;
    if (!msg) return res.sendStatus(200);

    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    let reply = 'I am alive ✅';

    if (text === '/ping') reply = 'pong';

    if (text === '/today') {
      const f = await preOpen();
      await saveForecast(f);   // 存盤前預言，收盤對帳用
      reply = f;
    }

    if (text === '/noon')  reply = await noonBrief();

    if (text === '/close') {
      const summary = await closeWrap(); // 收盤總結
      reply = await compareWithClose(summary); // 對帳結果
    }

    if (text.startsWith('/p ')) {
      const q = text.slice(3).trim();
      reply = await priceLookup(q);
    }

    await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
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
