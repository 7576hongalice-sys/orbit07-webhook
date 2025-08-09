// webhook_server.js
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";

const app = express();
app.use(bodyParser.json());

// ====== ENV（已內建你的憑證，可被環境變數覆蓋）======
const TOKEN  = process.env.BOT_TOKEN || "8279562243:AAEyhzGPAy7FeK-TvJQAbwhAPVLHXG_z2gY";
const CHAT_ID = process.env.CHAT_ID  || "8418229161";
const TG_API = `https://api.telegram.org/bot${TOKEN}`;

// 小工具：發送訊息到 Telegram
async function send(chatId, text) {
  try {
    const url = `${TG_API}/sendMessage`;
    const { data } = await axios.post(url, { chat_id: chatId, text });
    return data;
  } catch (err) {
    console.error("send error:", err?.response?.data || err.message);
    throw err;
  }
}

// Webhook：Telegram 會把使用者訊息 POST 到這裡
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.message;
    if (!msg) return res.sendStatus(200);

    const chatId = String(msg.chat.id);
    const text = (msg.text || "").trim();

    // 你要的行為放這裡（先回聲，之後可換成戀股/辰戀邏輯）
    await send(chatId, `你剛剛說：${text}`);
    return res.sendStatus(200);
  } catch (e) {
    console.error("webhook error:", e.message);
    return res.sendStatus(200);
  }
});

// 健康檢查
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "orbit07-webhook" });
});

// 手動測試：/ping?text=hello
app.get("/ping", async (req, res) => {
  const t = req.query.text || "Ping ✅";
  const r = await send(CHAT_ID, t);
  res.json(r);
});

// 啟動伺服器（Render 會注入 PORT）
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ webhook server listening on ${PORT}`);
});
