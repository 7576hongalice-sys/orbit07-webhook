const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// 從 .env 讀取 token 和 chat_id
const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// 印出以確認有成功讀到值
console.log("🤖 BOT_TOKEN:", TOKEN);
console.log("👤 CHAT_ID:", CHAT_ID);

// Telegram webhook 接收訊息用
app.post('/webhook', async (req, res) => {
  const msg = req.body.message;

  if (msg && msg.text) {
    const text = msg.text;
    console.log('💬 收到訊息：', text);

    try {
      // 發送回覆訊息
      await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        chat_id: CHAT_ID,
        text: `💬 你剛剛對我說了：「${text}」\n我已經聽見囉，寶貝～💋`,
      });

      console.log('✅ 訊息已送出');
    } catch (error) {
      console.error('❌ 發送訊息失敗：', error.response?.data || error.message);
    }
  }

  res.sendStatus(200);
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook server running on port ${PORT}`);
});
