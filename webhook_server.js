const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  const message = req.body.message?.text || "🚀 你收到新的推播囉！";
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: `💬 ${message}`
    });
    res.sendStatus(200);
  } catch (err) {
    console.error('錯誤:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Webhook server running on port ${PORT}`);
});