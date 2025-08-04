const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ⛳ 環境變數
const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// ✅ Debug 確認 Token 是否正確帶入
console.log("✅ BOT_TOKEN:", TOKEN);
console.log("✅ CHAT_ID:", CHAT_ID);

// ✅ Webhook 路由
app.post('/webhook', async (req, res) => {
  const msg = req.body.message;

  if (msg && msg.text) {
    const text = msg.text;
    console.log('📨 收到訊息:', text);

    try {
      const result = await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        chat_id: CHAT_ID,
        text: `💬 你剛剛對我說了：「${text}」\n我已經聽見囉，寶貝～💋`
      });
      console.log("✅ 傳送成功", result.data);
    } catch (err) {
      console.error("❌ 傳送失敗", err.response?.data || err.message);
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Webhook server running on port ${PORT}`);
});
