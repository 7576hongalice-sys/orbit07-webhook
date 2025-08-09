const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

// 你的 Telegram Bot Token 與 Chat ID
const TELEGRAM_TOKEN = "8279562243:AAEyhzGPAy7FeK-TvJQAbwhAPVLHXG_z2gY";
const CHAT_ID = "8418229161";
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

// Webhook 接收訊息
app.post("/webhook", async (req, res) => {
    const msg = req.body.message;

    if (msg && msg.text) {
        console.log("收到訊息：", msg.text);

        try {
            await axios.post(TELEGRAM_API, {
                chat_id: msg.chat.id,  // 回覆給發訊息的人
                text: `你剛剛說：${msg.text}`
            });
        } catch (err) {
            console.error("發送失敗：", err);
        }
    }

    res.sendStatus(200);
});

// 測試推播 API（直接推送訊息到你自己）
app.get("/send", async (req, res) => {
    try {
        await axios.post(TELEGRAM_API, {
            chat_id: CHAT_ID,
            text: "🚀 測試推播成功！這是來自我的 Node.js 伺服器"
        });
        res.send("推播已送出！");
    } catch (err) {
        console.error("推播失敗：", err);
        res.send("推播失敗");
    }
});

// Render/Heroku 監聽埠
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`伺服器已啟動在 ${PORT}`);
});
