const express = require("express");
const axios = require("axios");

const PORT = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const CRON_KEY = process.env.CRON_KEY || "";
const MODE = process.env.MODE || "precise"; // 你之前用的旗標；先保留

if (!TG_BOT_TOKEN || !CHAT_ID) {
  console.warn("⚠️ TG_BOT_TOKEN/CHAT_ID 未設定，將無法推播");
}

const app = express();
app.use(express.json());

// 小工具：統一發 Telegram
async function sendTG(text) {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  return axios.post(url, {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

// 驗證 CRON KEY
function verifyKey(req, res) {
  if (CRON_KEY && req.query.key !== CRON_KEY) {
    res.status(403).send("Forbidden");
    return false;
  }
  return true;
}

app.get("/health", (req, res) => {
  res.send("OK");
});

/**
 * 08:55 開盤提醒（GitHub Actions: cron_open.yml 會打這個）
 * 你後續要把「盤前導航 × 操作建議」產出接上來，可以在這裡呼叫你準備好的產生函式，
 * 現在先送一個固定格式樣板，確保整條鏈有動。
 */
app.post("/cron/open", async (req, res) => {
  if (!verifyKey(req, res)) return;
  const now = new Date().toLocaleString("zh-TW", { timeZone: process.env.TZ || "Asia/Taipei" });
  const text =
`🕗 <b>08:55 開盤提醒</b>
模式：<code>${MODE}</code>
時間：<code>${now}</code>

✅ 請確認是否有要掛單的個股
✅ 若要查建議請回：<code>今天買哪支</code>

— 稍晚我會依照你早上餵的資料整合：
• 國際盤/新聞重點
• 三大法人排行（含日） 
• 主場 × 五大模組共振分析
• 你的追蹤股共振狀況與建議
• 操作建議導航 / 開盤注意事項
`;
  try {
    await sendTG(text);
    res.send("open ok");
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).send("tg error");
  }
});

/**
 * 13:00 盤中小結
 */
app.post("/cron/noon", async (req, res) => {
  if (!verifyKey(req, res)) return;
  const now = new Date().toLocaleString("zh-TW", { timeZone: process.env.TZ || "Asia/Taipei" });
  const text =
`📰 <b>13:00 盤中小結</b>
時間：<code>${now}</code>

• 早盤劇本 vs 實際：<i>（之後接入你的盤中驗證規則）</i>
• 領漲族群/換手狀況：<i>（自動填）</i>
• 下午尾盤策略：<i>（自動填）</i>
`;
  try {
    await sendTG(text);
    res.send("noon ok");
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).send("tg error");
  }
});

/**
 * 16:30 收盤分析啟動
 * 你的 GitHub Actions cron_close.yml 會打這裡
 * 之後可在這裡觸發「自動抓追蹤/提到過個股的收盤價」→ 整合 → 產生兩份文件
 * 先發通知，確認鏈路無誤。
 */
app.post("/cron/close", async (req, res) => {
  if (!verifyKey(req, res)) return;
  const text =
`📉 <b>16:30 收盤分析啟動</b>

我會整合：
1) 你追蹤/提過的個股收盤資料
2) 你餵給我的三份來源（吳岳展／林睿閔／游庭皓、老王午報、投資家日報）
3) 8 大條件

➡️ 產出：
(1) 盤前導航 × 操作建議（明早 07:20 推）
(2) 個股預言 × 四價策略（同步推/可附 Word）
`;
  try {
    await sendTG(text);
    res.send("close ok");
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).send("tg error");
  }
});

/**
 * 可選：通用測試入口
 * curl -X POST '.../cron/ping?key=XXXX' -d '{"msg":"hi"}'
 */
app.post("/cron/ping", async (req, res) => {
  if (!verifyKey(req, res)) return;
  try {
    await sendTG(`🔔 <b>測試訊息</b>\n${req.body?.msg || "pong"}`);
    res.send("pong");
  } catch (e) {
    console.error(e?.response?.data || e.message);
    res.status(500).send("tg error");
  }
});

app.listen(PORT, () => {
  console.log(`Server on :${PORT}`);
});
