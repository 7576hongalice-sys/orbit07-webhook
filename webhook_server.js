const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.post('/webhook', async (req, res) => {
  // ✅ 印出 Telegram 傳來的整包資料
  console.log('🧾 收到完整資料:', JSON.stringify(req.body, null, 2));

  const msg = req.body.message;

  if (msg && msg.text) {
    const text = msg.text;
    console.log('✅ 收到文字訊息:', text);

    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: `💬 你剛剛對我說了：「${text}」\n我已經聽見囉，寶貝～💋`,
    });
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Webhook server running on port ${PORT}`);
});
