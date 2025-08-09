// CommonJS；使用 Node 18 內建 fetch（不需要 node-fetch）
const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

// ---- Day.js：固定台北時區 ----
dayjsBase.extend(utc);
dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

// ---- 憑證（可被環境變數覆蓋）----
const TOKEN   = process.env.BOT_TOKEN || "8279562243:AAEyhzGPAy7FeK-TvJQAbwhAPVLHXG_z2gY";
const CHAT_ID = process.env.CHAT_ID   || "8418229161";
const TG_API  = `https://api.telegram.org/bot${TOKEN}`;

const app = express();
app.use(express.json());

// ---- 小工具：發送訊息（含錯誤偵測）----
async function send(chatId, text) {
  try {
    const url = `${TG_API}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      console.error("❌ sendMessage 失敗",
        { httpStatus: res.status, httpText: res.statusText, tg: data, text });
      throw new Error("sendMessage failed");
    }
    console.log("✅ sendMessage 成功", { to: chatId, text });
    return data;
  } catch (e) {
    console.error("❌ send() exception:", e);
    throw e;
  }
}
function isWeekday(d = dayjs()) { const w = d.day(); return w >= 1 && w <= 5; }
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
}

// ---- 健康檢查／首頁（方便你測）----
app.get("/", (req, res) => {
  res.send({ ok: true, service: "orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") });
});
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") });
});

// ---- /ping：推播測試（最重要的排錯入口）----
app.get("/ping", async (req, res) => {
  const t = req.query.text || "Ping ✅";
  try {
    const j = await send(CHAT_ID, t);
    res.json(j);
  } catch (e) {
    res.status(500).json({ ok: false, msg: "ping failed" });
  }
});

// ---- /webhook：先回 200，再非同步處理，避免 Telegram 超時 ----
app.post("/webhook", (req, res) => {
  res.sendStatus(200); // 立即回覆，避免 10 秒超時

  const run = async () => {
    try {
      const update = req.body;
      console.log("📩 TG update:", JSON.stringify(update));

      const msg =
        update.message ||
        update.edited_message ||
        update.channel_post ||
        update.edited_channel_post;

      if (!msg) { console.log("⚠️ 無 message，略過"); return; }

      const chatId = String(msg.chat?.id);
      const text = (msg.text || msg.caption || "").trim();

      if (!chatId) { console.log("⚠️ 無 chatId，略過"); return; }

      if (text.startsWith("/")) {
        await handleCommand(chatId, text);
        return;
      }

      await send(chatId, `收到：「${text || "(非文字訊息)"}」～要我產出盤前/盤後報告嗎？`);
    } catch (e) {
      console.error("❌ webhook handler error:", e);
    }
  };

  if (typeof queueMicrotask === "function") queueMicrotask(run);
  else setImmediate(run);
});

// ---- 推播排程（全部以 Asia/Taipei）----
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
