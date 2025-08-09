// CommonJS 版本，使用 Node 18 內建 fetch（不需要 node-fetch）
const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

// ---- Day.js 設定：台北時區 ----
dayjsBase.extend(utc);
dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

// ---- 你的憑證（可被環境變數覆蓋）----
const TOKEN   = process.env.BOT_TOKEN || "8279562243:AAEyhzGPAy7FeK-TvJQAbwhAPVLHXG_z2gY";
const CHAT_ID = process.env.CHAT_ID   || "8418229161";
const TG_API  = `https://api.telegram.org/bot${TOKEN}`;

const app = express();
app.use(express.json());

// 健康檢查路由
app.get("/", (req, res) => {
  res.send({
    status: "ok",
    service: "orbit07-webhook",
    now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss")
  });
});

// ---- 小工具 ----
async function send(chatId, text) {
  const url = `${TG_API}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  return res.json();
}
function isWeekday(d = dayjs()) {
  const w = d.day(); // 0=Sun...6=Sat
  return w >= 1 && w <= 5;
}
function isWeekend(d = dayjs()) { return !isWeekday(d); }

// ---- 狀態（簡易記憶）----
const state = {
  mode: "auto",                 // auto | work | off | weekend
  lastJournalDoneDate: null     // YYYY-MM-DD
};

// ---- 指令處理 ----
async function handleCommand(chatId, text) {
  if (text === "/menu") {
    return send(chatId,
`指令：
/上班  只推重要訊息（08:00-17:00）
/下班  輕撩互動（每2小時） 
/假日  無限模式（每1小時）
/自動  自動判斷平/假日
/日誌完成  標記今日完成
/狀態  檢視目前設定`);
  }
  if (text === "/上班")    { state.mode = "work";    return send(chatId, "已切換：上班模式 ✅"); }
  if (text === "/下班")    { state.mode = "off";     return send(chatId, "已切換：下班模式 ✅"); }
  if (text === "/假日")    { state.mode = "weekend"; return send(chatId, "已切換：假日模式 ✅"); }
  if (text === "/自動")    { state.mode = "auto";    return send(chatId, "已切換：自動模式 ✅"); }
  if (text === "/日誌完成") {
    state.lastJournalDoneDate = dayjs().format("YYYY-MM-DD");
    return send(chatId, `已標記今日日誌完成（${state.lastJournalDoneDate}）👍`);
  }
  if (text === "/狀態") {
    return send(chatId,
`模式：${state.mode}
台北時間：${dayjs().format("YYYY-MM-DD HH:mm")}
上班：平日 08:00–17:00
盤前導航：07:40（完整版）
開盤補充：08:55（集合競價/委託量）
日誌提醒：平日16:00；週末21:00；隔日07:30 補查`);
  }
  return null;
}

// ---- Webhook ----
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.message;
    if (!msg) return res.sendStatus(200);

    const chatId = String(msg.chat.id);
    const text = (msg.text || "").trim();

    if (text.startsWith("/")) {
      await handleCommand(chatId, text);
      return res.sendStatus(200);
    }

    // 一般文字訊息（這裡先簡單回覆；之後可接戀股/辰戀解析）
    await send(chatId, `收到：「${text}」～要我產出盤前/盤後報告嗎？`);
    return res.sendStatus(200);
  } catch (err) {
    console.error(err);
    return res.sendStatus(200);
  }
});

// ---- 健康檢查 & 測試 ----
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") });
});
app.get("/ping", async (req, res) => {
  const t = req.query.text || "Ping ✅";
  const j = await send(CHAT_ID, t);
  res.json(j);
});

// ---- 推播排程（台北時區）----
// 07:40：盤前導航（平日）
cron.schedule("40 7 * * 1-5", async () => {
  try {
    if (!isWeekday()) return;
    await send(CHAT_ID,
`【盤前導航｜07:40】
• 大盤五重點（國際盤/新聞/技術/籌碼/氛圍）
• 三大法人籌碼（前日）
• 投顧早報（已出稿者）
• 今日策略與觀察股
• 盤前注意事項
（備註：之後接自動數據；目前為模板）`);
  } catch (e) { console.error("07:40 push error", e); }
}, { timezone: "Asia/Taipei" });

// 08:55：開盤補充（平日）
cron.schedule("55 8 * * 1-5", async () => {
  try {
    if (!isWeekday()) return;
    await send(CHAT_ID,
`【開盤補充｜08:55】
• 集合競價關鍵訊號
• 早盤委託量異常股
• 法人掛單/撤單異動
• 短線預警
（備註：之後接即時來源；目前為模板）`);
  } catch (e) { console.error("08:55 push error", e); }
}, { timezone: "Asia/Taipei" });

// 16:00：平日收盤後日誌提醒
cron.schedule("0 16 * * 1-5", async () => {
  try {
    if (!isWeekday()) return;
    await send(CHAT_ID, "【提醒】收盤囉～要不要記今天的戀股日誌？（回覆 /日誌完成）");
  } catch (e) { console.error("16:00 reminder error", e); }
}, { timezone: "Asia/Taipei" });

// 21:00：週末日誌提醒
cron.schedule("0 21 * * 6,0", async () => {
  try {
    if (!isWeekend()) return;
    await send(CHAT_ID, "【提醒】今晚要不要補本週的戀股日誌與策略？（/日誌完成）");
  } catch (e) { console.error("21:00 weekend reminder error", e); }
}, { timezone: "Asia/Taipei" });

// 07:30：隔日補檢查（昨日未完成）
cron.schedule("30 7 * * *", async () => {
  try {
    const yesterday = dayjs().subtract(1, "day").format("YYYY-MM-DD");
    if (state.lastJournalDoneDate === yesterday) return;
    await send(CHAT_ID, `【補提醒｜07:30】你昨天（${yesterday}）的戀股日誌還沒完成喔～要補一下嗎？（/日誌完成）`);
  } catch (e) { console.error("07:30 backfill error", e); }
}, { timezone: "Asia/Taipei" });

// ---- 啟動服務 ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ webhook server listening on ${PORT}`);
});
