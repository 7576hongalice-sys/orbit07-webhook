// CommonJS；使用 Node 18 內建 fetch
const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

// ---- Day.js：固定台北時區 ----
dayjsBase.extend(utc);
dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

// ---- ENV（可用 Render 的 Environment 覆蓋）----
const TOKEN   = process.env.BOT_TOKEN || "8279562243:AAEyhzGPAy7FeK-TvJQAbwhAPVLHXG_z2gY";
const CHAT_ID = process.env.CHAT_ID   || "8418229161";
const PING_KEY = process.env.PING_KEY || "dev-only"; // 自訂一組值；沒設就用開發用字串
const TG_API  = `https://api.telegram.org/bot${TOKEN}`;

const app = express();
app.use(express.json());

// ---- 小工具 ----
async function send(chatId, text, extra = {}) {
  const url = `${TG_API}/sendMessage`;
  const body = { chat_id: chatId, text, ...extra };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await res.json();
  if (!j.ok) {
    console.error("send() exception:", j);
    throw new Error("sendMessage failed");
  }
  return j;
}
const isWeekday = (d = dayjs()) => {
  const w = d.day(); // 0=Sun...6=Sat
  return w >= 1 && w <= 5;
};
const isWeekend = (d = dayjs()) => !isWeekday(d);

// ---- 狀態（簡易記憶）----
const state = {
  mode: "auto",                 // auto | work | off | weekend
  lastJournalDoneDate: null     // YYYY-MM-DD
};

// ---- Reply Keyboard ----
const menuKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: "/上班" }, { text: "/下班" }],
      [{ text: "/假日" }, { text: "/自動" }],
      [{ text: "/狀態" }, { text: "/日誌完成" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

// ---- 指令處理 ----
async function handleCommand(chatId, text) {
  if (text === "/start") {
    await send(chatId, "嗨～我在這裡噢！下面是常用指令，先試 /menu 看看 👇", menuKeyboard);
    return send(chatId,
`指令：
/上班  只推重要訊息（08:00-17:00）
/下班  輕撩互動（每2小時） 
/假日  無限模式（每1小時）
/自動  自動判斷平/假日
/日誌完成  標記今日完成
/狀態  檢視目前設定`, menuKeyboard);
  }

  if (text === "/menu") {
    return send(chatId,
`指令：
/上班  只推重要訊息（08:00-17:00）
/下班  輕撩互動（每2小時） 
/假日  無限模式（每1小時）
/自動  自動判斷平/假日
/日誌完成  標記今日完成
/狀態  檢視目前設定`, menuKeyboard);
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

  if (text === "/chatid") {
    return send(chatId, `這個聊天室的 chat_id 是：${chatId}`);
  }

  // 其他未知指令就回菜單
  return send(chatId, "看不懂這個指令耶～輸入 /menu 看看可以做什麼吧！", menuKeyboard);
}

// ---- 健康檢查／首頁 ----
app.get("/", (_req, res) => {
  res.send({ ok: true, service: "orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") });
});
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") });
});

// ---- /ping：推播測試（需要 ?key=）----
app.get("/ping", async (req, res) => {
  const key = String(req.query.key || "");
  const t = String(req.query.text || "Ping ✅");
  if (key !== PING_KEY) return res.status(401).json({ ok: false, msg: "unauthorized" });
  try {
    const j = await send(CHAT_ID, t);
    res.json({ ok: true, result: j });
  } catch (e) {
    console.error("ping error:", e);
    res.status(500).json({ ok: false, msg: "ping failed" });
  }
});

// ---- /webhook：回 200，再非同步處理 ----
app.post("/webhook", (req, res) => {
  // 先立即回應，避免 Telegram 10 秒超時
  res.sendStatus(200);

  const run = async () => {
    try {
      const update = req.body;
      console.log("TG update:", JSON.stringify(update));

      const msg =
        update.message ||
        update.edited_message ||
        update.channel_post ||
        update.edited_channel_post;

      if (!msg) return;

      const chatId = String(msg.chat?.id);
      const text = (msg.text || msg.caption || "").trim();
      if (!chatId) return;

      if (text.startsWith("/")) {
        await handleCommand(chatId, text);
      }
      // ⛔️ 不再做一般文字的自動回覆（避免干擾對話）
    } catch (e) {
      console.error("webhook handler error:", e);
    }
  };

  if (typeof queueMicrotask === "function") queueMicrotask(run);
  else setImmediate(run);
});

// ---- 推播排程（全部以 Asia/Taipei）----
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
