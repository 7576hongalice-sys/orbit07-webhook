// CommonJS；Node 18 內建 fetch
const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

// ---- Day.js：固定台北時區 ----
dayjsBase.extend(utc);
dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

// ---- ENV（不要寫死）----
const TOKEN   = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID   || "";
const TG_API  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : "";

const app = express();
app.use(express.json());

// ---- 小工具 ----
async function send(chatId, text) {
  if (!TG_API) throw new Error("BOT_TOKEN 未設定");
  const url = `${TG_API}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`sendMessage failed: ${JSON.stringify(j)}`);
  return j;
}
const isWeekday = (d = dayjs()) => {
  const w = d.day();
  return w >= 1 && w <= 5;
};
const isWeekend = (d = dayjs()) => !isWeekday(d);

// ---- 狀態（簡易記憶）----
const state = {
  mode: "auto",                 // auto | work | off | weekend
  lastJournalDoneDate: null     // YYYY-MM-DD
};

// ---- 健康檢查／首頁 ----
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "orbit07-webhook",
    now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss")
  });
});
app.get("/health", (req, res) => {
  // Render Health Check 用，必須回 200
  res.status(200).send("OK");
});

// ---- /ping：推播測試 ----
app.get("/ping", async (req, res) => {
  try {
    const t = req.query.text || "Ping ✅";
    const j = await send(CHAT_ID || String(req.query.chat_id || ""), t);
    res.json({ ok: true, result: j });
  } catch (e) {
    console.error("send() exception:", e);
    res.status(500).json({ ok: false, msg: "ping failed" });
  }
});

// ---- 指令處理 ----
async function handleCommand(chatId, text) {
  if (text === "/menu" || text === "/start" || text === "/Start") {
    return send(chatId,
`可用指令：
/上班  只推重要訊息（08:00-17:00）
/自動  平/假日自動判斷
/日誌完成  標記今日完成
/狀態  檢視目前設定`);
  }
  if (text === "/上班")    { state.mode = "work";    return send(chatId, "已切換：上班模式 ✅"); }
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
盤前導航：07:40（平日）
開盤補充：08:55（平日）
日誌提醒：平日16:30；週末21:00；隔日07:30 補查`);
  }
}

// ---- Webhook：先回 200，再非同步處理 ----
app.post("/webhook", (req, res) => {
  // 立即回 200，避免 Telegram 10 秒超時
  res.sendStatus(200);

  const run = async () => {
    try {
      const update = req.body || {};
      // console.log("TG update:", JSON.stringify(update)); // 如需除錯再打開

      const msg =
        update.message ||
        update.edited_message ||
        update.channel_post ||
        update.edited_channel_post;

      if (!msg) return;

      const chatId = String(msg.chat?.id || "");
      const text = (msg.text || msg.caption || "").trim();

      if (!chatId) return;

      if (text.startsWith("/")) {
        await handleCommand(chatId, text);
        return;
      }

      // 一般訊息回覆（placeholder）
      await send(chatId, `收到：「${text || "(非文字訊息)"}」～要我產出盤前/盤後報告嗎？`);
    } catch (e) {
      console.error("webhook handler error:", e);
    }
  };

  if (typeof queueMicrotask === "function") queueMicrotask(run);
  else setImmediate(run);
});

// ---- 推播排程（以 Asia/Taipei）----
cron.schedule("40 7 * * 1-5", async () => {
  try {
    if (!isWeekday()) return;
    await send(CHAT_ID, "【盤前導航｜07:40】（模板）");
  } catch (e) { console.error("07:40 push error", e); }
}, { timezone: "Asia/Taipei" });

cron.schedule("55 8 * * 1-5", async () => {
  try {
    if (!isWeekday()) return;
    await send(CHAT_ID, "【開盤補充｜08:55】（模板）");
  } catch (e) { console.error("08:55 push error", e); }
}, { timezone: "Asia/Taipei" });

cron.schedule("30 16 * * 1-5", async () => {
  try {
    if (!isWeekday()) return;
    await send(CHAT_ID, "【提醒】收盤囉～要不要記今天的戀股日誌？（/日誌完成）");
  } catch (e) { console.error("16:30 reminder error", e); }
}, { timezone: "Asia/Taipei" });

cron.schedule("0 21 * * 6,0", async () => {
  try {
    if (!isWeekend()) return;
    await send(CHAT_ID, "【提醒】今晚要不要補本週的戀股日誌與策略？（/日誌完成）");
  } catch (e) { console.error("21:00 weekend reminder error", e); }
}, { timezone: "Asia/Taipei" });

cron.schedule("30 7 * * *", async () => {
  try {
    const yesterday = dayjs().subtract(1, "day").format("YYYY-MM-DD");
    if (state.lastJournalDoneDate === yesterday) return;
    await send(CHAT_ID, `【補提醒｜07:30】你昨天（${yesterday}）的戀股日誌還沒完成喔～要補一下嗎？（/日誌完成）`);
  } catch (e) { console.error("07:30 backfill error", e); }
}, { timezone: "Asia/Taipei" });

// ---- 啟動服務（重點：用 Render 提供的 PORT）----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ webhook server listening on ${PORT}`);
});
