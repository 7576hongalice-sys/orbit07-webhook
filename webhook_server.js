// CommonJS；Node 18 內建 fetch（不需要 node-fetch）
const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

// ---- Day.js：固定台北時區 ----
dayjsBase.extend(utc);
dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

// ---- 讀 ENV 並「去引號」避免 404: Not Found ----
const clean = (v) =>
  String(v ?? "")
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/^'+|'+$/g, "");

const RAW_TOKEN  = process.env.BOT_TOKEN || "8279562243:AAEyhzGPAy7FeK-TvJQAbwhAPVLHXG_z2gY";
const RAW_CHATID = process.env.CHAT_ID   || "8418229161";

const TOKEN   = clean(RAW_TOKEN);
const CHAT_ID = clean(RAW_CHATID);
const TG_API  = `https://api.telegram.org/bot${TOKEN}`;

console.log("[boot] chat_id =", CHAT_ID);
console.log("[boot] token_tail =", TOKEN.slice(-8)); // 只印尾段避免外流

const app = express();
app.use(express.json());

// ---- 發送工具（含詳細錯誤輸出）----
async function send(chatId, text) {
  const url = `${TG_API}/sendMessage`;
  const body = { chat_id: chatId, text };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let j = {};
  try { j = await res.json(); } catch (e) {}

  console.log("tg req:", { url, body });
  console.log("tg res:", j);

  if (!j.ok) throw new Error(`sendMessage failed: ${j?.description || res.statusText}`);
  return j;
}

function isWeekday(d = dayjs()) { const w = d.day(); return w >= 1 && w <= 5; }
function isWeekend(d = dayjs()) { return !isWeekday(d); }

// ---- 狀態（簡易記憶）----
const state = { mode: "auto", lastJournalDoneDate: null };

// ---- 指令處理 ----
async function handleCommand(chatId, text) {
  if (text === "/menu" || text === "/start" || text === "/Start") {
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
}

// ---- 健康檢查／首頁 ----
app.get("/",       (req, res) => res.json({ ok: true, service: "orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") }));
app.get("/health", (req, res) => res.json({ ok: true, service: "orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") }));

// ---- /ping：推播測試（失敗會回傳原因）----
app.get("/ping", async (req, res) => {
  const t = req.query.text || "Ping ✅";
  try {
    const j = await send(CHAT_ID, t);
    res.json({ ok: true, result: j });
  } catch (e) {
    console.error("send() exception:", e?.message);
    res.status(500).json({ ok: false, msg: e?.message || "ping failed" });
  }
});

// ---- /webhook：先回 200，再非同步處理 ----
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  const run = async () => {
    try {
      const u = req.body;
      console.log("TG update:", JSON.stringify(u));
      const msg =
        u.message || u.edited_message ||
        u.channel_post || u.edited_channel_post;
      if (!msg) return;

      const chatId = String(msg.chat?.id || "");
      const text = (msg.text || msg.caption || "").trim();
      if (!chatId) return;

      if (text.startsWith("/")) {
        await handleCommand(chatId, text);
        return;
      }
      await send(chatId, `收到：「${text || "(非文字訊息)"}」～要我產出盤前/盤後報告嗎？`);
    } catch (e) {
      console.error("webhook handler error:", e);
    }
  };
  if (typeof queueMicrotask === "function") queueMicrotask(run);
  else setImmediate(run);
});

// ---- 排程（Asia/Taipei）----
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

cron.schedule("0 16 * * 1-5", async () => {
  try {
    if (!isWeekday()) return;
    await send(CHAT_ID, "【提醒】收盤囉～要不要記今天的戀股日誌？（回覆 /日誌完成）");
  } catch (e) { console.error("16:00 reminder error", e); }
}, { timezone: "Asia/Taipei" });

cron.schedule("0 21 * * 6,0", async () => {
  try {
    if (!isWeekend()) return;
    await send(CHAT_ID, "【提醒】今晚要不要補本週的戀股日誌與策略？（/日誌完成）");
  } catch (e) { console.error("21:00 weekend reminder error", e); }
}, { timezone: "Asia/Taipei" });

cron.schedule("30 7 * * *", async () => {
  try {
    const y = dayjs().subtract(1, "day").format("YYYY-MM-DD");
    if (state.lastJournalDoneDate === y) return;
    await send(CHAT_ID, `【補提醒｜07:30】你昨天（${y}）的戀股日誌還沒完成喔～要補一下嗎？（/日誌完成）`);
  } catch (e) { console.error("07:30 backfill error", e); }
}, { timezone: "Asia/Taipei" });

// ---- 啟動 ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ webhook server listening on ${PORT}`));
