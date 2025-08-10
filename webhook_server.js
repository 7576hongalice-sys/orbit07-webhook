// webhook_server.js
// Node 18 內建 fetch；Express webhook + Taipei cron + Telegram Bot
const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

// ---- Day.js：固定台北時區 ----
dayjsBase.extend(utc);
dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

// ---- 憑證（環境變數優先，否則用你的 Token/ChatId）----
const TOKEN   = process.env.BOT_TOKEN || "8279562243:AAEyhzGPAy7FeK-TvJQAbwhAPVLHXG_z2gY";
const CHAT_ID = process.env.CHAT_ID   || "8418229161";
const TG_API  = `https://api.telegram.org/bot${TOKEN}`;

const app = express();
app.use(express.json());

// ---- 小工具 ----
async function send(chatId, text, extra = {}) {
  const url = `${TG_API}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await res.json();
  if (!j.ok) throw new Error("sendMessage failed");
  return j;
}

function isWeekday(d = dayjs()) { const w = d.day(); return w >= 1 && w <= 5; }
function isWeekend(d = dayjs()) { return !isWeekday(d); }

// ---- 狀態（簡易記憶）----
const state = {
  mode: "auto",                 // auto | work | off | weekend  （目前只用 auto/work）
  lastJournalDoneDate: null     // YYYY-MM-DD
};

// ---- Reply Keyboard（常駐快捷鍵）----
async function tgReplyKeyboard(chatId) {
  const keyboard = [
    [{ text: "查價" }, { text: "清單" }, { text: "追蹤收盤" }],
    [{ text: "clip 摘要 今日" }, { text: "clip 清單" }],
    [{ text: "狀態" }, { text: "上班" }, { text: "自動" }],
    [{ text: "洗澡提醒" }, { text: "睡覺提醒" }],
  ];
  return send(chatId, "功能列已就緒，直接點按即可；也可直接輸入「查佳能」「股價 2330」。", {
    reply_markup: { keyboard, resize_keyboard: true, is_persistent: true }
  });
}

// ---- 指令處理：同時支援「/指令」與「沒有斜線的快捷鍵」----
// 有處理就回傳 {handled:true}；沒命中回傳 null
async function handleCommand(chatId, rawText, msg) {
  if (!rawText) return null;
  const text = rawText.trim();
  const tNoSlash = text.startsWith("/") ? text.slice(1).trim() : text;
  const lower = tNoSlash.toLowerCase();

  // 菜單 / start
  if (lower === "start" || lower === "menu") {
    await tgReplyKeyboard(chatId);
    const help =
`可用指令：
/上班　只推重要訊息（08:00-17:00）
/自動　平/假日自動判斷
/狀態　檢視目前設定
/股價　代號或名稱（例：/股價 2374 或 /股價 佳能）
/口語查價開｜/口語查價關（保留位） 
/clip開｜/clip關（保留位）
/速報冷卻 分鐘（例：/速報冷卻 10）

也可直接點下方功能列（無斜線）。`;
    await send(chatId, help);
    return { handled: true };
  }

  // 模式切換
  if (["上班", "work"].includes(lower)) {
    state.mode = "work";
    await send(chatId, "已切換：上班模式 ✅");
    return { handled: true };
  }
  if (["自動", "auto"].includes(lower)) {
    state.mode = "auto";
    await send(chatId, "已切換：自動模式 ✅");
    return { handled: true };
  }

  // 狀態
  if (lower === "狀態" || lower === "status") {
    const s =
`模式：${state.mode}
台北時間：${dayjs().format("YYYY-MM-DD HH:mm")}
上班：平日 08:00–17:00
盤前導航：07:40（平日）
開盤補充：08:55（平日）
日誌提醒：平日16:30；週末21:00；隔日07:30 補查`;
    await send(chatId, s);
    return { handled: true };
  }

  // 查價（簡版：先支援數字代號；名稱查價之後補股票名錄）
  // 允許格式：「股價 2330」「/股價 2330」「查價 2330」「/查價 2330」
  const mCode = tNoSlash.match(/^(?:股價|查價)\s*(\d{4})$/);
  if (mCode) {
    const code = mCode[1];
    // 這裡改成你實際抓價函式；暫時回模板
    await send(chatId, `【${code}｜TWSE】 ${dayjs().format("YY/MM/DD")} 收：—（開:— 高:— 低:—）`);
    return { handled: true };
  }

  // 快捷字：查價 / 清單 / 追蹤收盤 / clip…
  if (lower === "查價") {
    await send(chatId, "請輸入：股價 代號　或　股價 名稱（例：股價 2330 / 股價 佳能）");
    return { handled: true };
  }
  if (lower === "清單") {
    await send(chatId, "（清單）功能待補：會顯示你的追蹤與持股清單。");
    return { handled: true };
  }
  if (lower === "追蹤收盤") {
    await send(chatId, "已收到，將以 16:30 的收盤價為準整理後推送。");
    return { handled: true };
  }
  if (lower === "clip 摘要 今日" || lower === "clip清單" || lower === "clip 清單") {
    await send(chatId, "Clip 功能位保留（之後接入）。");
    return { handled: true };
  }

  // 生活提醒（開關）
  if (lower === "洗澡提醒") {
    await send(chatId, "21:30 洗澡提醒已啟用 ✅");
    return { handled: true };
  }
  if (lower === "睡覺提醒") {
    await send(chatId, "23:00 睡覺提醒已啟用 ✅");
    return { handled: true };
  }

  // 其他斜線設定（相容舊用法）
  if (text.startsWith("/")) {
    // 可以加更多 / 指令，這裡先簡化處理為未命中
    return { handled: true };
  }

  // 沒命中任何指令
  return null;
}

// ---- 健康檢查／首頁 ----
app.get("/", (req, res) => {
  res.send({ ok: true, service: "orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") });
});
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") });
});

// ---- /ping：推播測試 ----
app.get("/ping", async (req, res) => {
  const t = req.query.text || "Ping ✅";
  try {
    const j = await send(CHAT_ID, t);
    res.json({ ok: true, result: j.result });
  } catch (e) {
    console.error("ping error:", e);
    res.status(500).json({ ok: false, msg: "ping failed" });
  }
});

// ---- /webhook：先回 200，再非同步處理 ----
app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  const run = async () => {
    try {
      const update = req.body;
      // console.log("TG update:", JSON.stringify(update));

      const msg =
        update.message ||
        update.edited_message ||
        update.channel_post ||
        update.edited_channel_post;

      if (!msg) return;

      const chatId = String(msg.chat?.id);
      const text = (msg.text || msg.caption || "").trim();
      if (!chatId) return;

      // ✅ 先嘗試處理指令（包含沒有 / 的快捷鍵）
      const handled = await handleCommand(chatId, text, msg);
      if (handled !== null) {
        // /start 或 /menu 後補上鍵盤（handleCommand 內已處理）
        return;
      }

      // ⬇️ 沒命中指令 → 視為一般訊息（例如轉貼文章），走即時解析
      //   這裡先做占位回覆，你之後可接 OCR/規則等
      const preview =
`【即時解析】未標記來源｜${dayjs().format("YYYY-MM-DD HH:mm:ss")}
1. ${text.slice(0, 18) || "（空）"}`;

      await send(chatId, preview);
    } catch (e) {
      console.error("webhook handler error:", e);
    }
  };

  if (typeof queueMicrotask === "function") queueMicrotask(run);
  else setImmediate(run);
});

// ---- 推播排程（Asia/Taipei）----
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

// 16:30：平日收盤後日誌提醒（由原 16:00 調整為 16:30）
cron.schedule("30 16 * * 1-5", async () => {
  try {
    if (!isWeekday()) return;
    await send(CHAT_ID, "【提醒】收盤囉～要不要記今天的戀股日誌？（回覆 日誌完成）");
  } catch (e) { console.error("16:30 reminder error", e); }
}, { timezone: "Asia/Taipei" });

// 21:00：週末日誌提醒
cron.schedule("0 21 * * 6,0", async () => {
  try {
    if (!isWeekend()) return;
    await send(CHAT_ID, "【提醒】今晚要不要補本週的戀股日誌與策略？（日誌完成）");
  } catch (e) { console.error("21:00 weekend reminder error", e); }
}, { timezone: "Asia/Taipei" });

// 07:30：隔日補檢查（昨日未完成）
cron.schedule("30 7 * * *", async () => {
  try {
    const yesterday = dayjs().subtract(1, "day").format("YYYY-MM-DD");
    if (state.lastJournalDoneDate === yesterday) return;
    await send(CHAT_ID, `【補提醒｜07:30】你昨天（${yesterday}）的戀股日誌還沒完成喔～要補一下嗎？（日誌完成）`);
  } catch (e) { console.error("07:30 backfill error", e); }
}, { timezone: "Asia/Taipei" });

// ---- 啟動服務 ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ webhook server listening on ${PORT}`);
});
