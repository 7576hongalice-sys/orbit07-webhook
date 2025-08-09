import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";
import dayjsBase from "dayjs";
import utc from "dayjs-plugin-utc";
import tz from "dayjs-plugin-timezone";

dayjsBase.extend(utc);
dayjsBase.extend(tz);
const dayjs = (d = undefined) => dayjsBase.tz(d, "Asia/Taipei");

const app = express();
app.use(express.json());

// ====== ENV（已內建你的憑證，可被環境變數覆蓋）======
const TOKEN  = process.env.BOT_TOKEN || "8279562243:AAEyhzGPAy7FeK-TvJQAbwhAPVLHXG_z2gY";
const CHAT_ID = process.env.CHAT_ID  || "8418229161";
const TG_API = `https://api.telegram.org/bot${TOKEN}`;

// ====== 小工具 ======
async function send(chatId, text) {
  const url = `${TG_API}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  return r.json();
}
function isWeekday(d = dayjs()) {
  const dow = d.day(); // 0=Sun ... 6=Sat
  return dow >= 1 && dow <= 5;
}
function isWeekend(d = dayjs()) {
  return !isWeekday(d);
}

// ====== 狀態儲存（記憶） ======
const state = {
  mode: "auto", // auto | work | off | weekend
  lastJournalDoneDate: null, // YYYY-MM-DD
};

// ====== 指令（手動切換） ======
async function handleCommand(chatId, text) {
  if (text === "/menu") {
    return send(chatId,
`指令選單：
/上班  切換上班模式（08:00-17:00 只推重要訊息）
/下班  切換下班模式（輕撩互動，每2小時一次）
/假日  切換假日模式（每1小時一次）
/自動  回到自動判斷（平日/假日自動切換）
/日誌完成  標記今日戀股日誌已完成
/狀態  查看目前模式與時間設定`);
  }
  if (text === "/上班") { state.mode = "work"; return send(chatId, "已切換：上班模式 ✅"); }
  if (text === "/下班") { state.mode = "off";  return send(chatId, "已切換：下班模式 ✅"); }
  if (text === "/假日") { state.mode = "weekend"; return send(chatId, "已切換：假日模式 ✅"); }
  if (text === "/自動") { state.mode = "auto"; return send(chatId, "已切換：自動模式 ✅"); }
  if (text === "/日誌完成") {
    state.lastJournalDoneDate = dayjs().format("YYYY-MM-DD");
    return send(chatId, `已標記今日日誌完成（${state.lastJournalDoneDate}）👍`);
  }
  if (text === "/狀態") {
    return send(chatId,
`模式：${state.mode}
現在台北時間：${dayjs().format("YYYY-MM-DD HH:mm")}
上班區間：平日 08:00–17:00
盤前導航：07:40（完整版）
開盤補充：08:55（集合競價/委託量）
日誌提醒：平日16:00；週末21:00；隔日07:30補查`);
  }
  return null;
}

// ====== Webhook（可選；你已綁 /webhook 就會進來） ======
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    const msg = update?.message;
    if (!msg) return res.sendStatus(200);

    const chatId = String(msg.chat.id);
    const text = (msg.text || "").trim();

    // 指令
    if (text.startsWith("/")) {
      await handleCommand(chatId, text);
      return res.sendStatus(200);
    }

    // 文字訊息（這裡先簡單回收；之後你要我接「辰戀核心TG／戀股主場TG」解析可再擴充）
    await send(chatId, `收到～你說「${text}」。需要我幫你生成盤前/盤後報告嗎？`);
    return res.sendStatus(200);
  } catch (e) {
    console.error(e);
    return res.sendStatus(200);
  }
});

// ====== 健康檢查／手動測試 ======
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "orbit07-tg-core", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") });
});
app.get("/ping", async (req, res) => {
  const t = req.query.text || "Ping ✅";
  const j = await send(CHAT_ID, t);
  res.json(j);
});

// ====== 推播任務：台北時區 ======
// 07:40 — 盤前導航（完整版，平日）
cron.schedule("40 7 * * 1-5", async () => {
  try {
    const now = dayjs();
    if (!isWeekday(now)) return;
    await send(CHAT_ID,
`【盤前導航｜07:40】
• 大盤五重點（國際盤/新聞/技術/籌碼/氛圍）
• 三大法人籌碼（前日）
• 投顧早報（已出稿者）
• 今日策略與觀察股
• 盤前注意事項
（備註：之後會接入自動資料來源；現在為模板提示）`);
  } catch (e) { console.error("07:40 push error", e); }
}, { timezone: "Asia/Taipei" });

// 08:55 — 開盤即時補充（平日，重要訊息允許上班時段）
cron.schedule("55 8 * * 1-5", async () => {
  try {
    const now = dayjs();
    if (!isWeekday(now)) return;
    await send(CHAT_ID,
`【開盤補充｜08:55】
• 集合競價關鍵訊號
• 早盤委託量異常股
• 法人掛單／撤單異動
• 短線預警
（備註：之後接即時來源；現在為模板提示）`);
  } catch (e) { console.error("08:55 push error", e); }
}, { timezone: "Asia/Taipei" });

// 16:00 — 平日收盤後日誌提醒
cron.schedule("0 16 * * 1-5", async () => {
  try {
    if (!isWeekday()) return;
    await send(CHAT_ID, "【提醒】收盤了～要不要記一下今天的戀股日誌？（回覆 /日誌完成 來標記）");
  } catch (e) { console.error("16:00 reminder error", e); }
}, { timezone: "Asia/Taipei" });

// 21:00 — 假日（或週末晚間）日誌提醒
cron.schedule("0 21 * * 6,0", async () => {
  try {
    if (!isWeekend()) return;
    await send(CHAT_ID, "【提醒】今晚要不要補一下本週的戀股日誌與策略？（回覆 /日誌完成 ）");
  } catch (e) { console.error("21:00 weekend reminder error", e); }
}, { timezone: "Asia/Taipei" });

// 次日 07:30 — 補檢查（昨日未完成日誌則提醒）
cron.schedule("30 7 * * *", async () => {
  try {
    const today = dayjs().format("YYYY-MM-DD");
    const yesterday = dayjs().subtract(1, "day").format("YYYY-MM-DD");
    if (state.lastJournalDoneDate === yesterday) return; // 昨日已完成
    await send(CHAT_ID, `【補提醒｜07:30】你昨天（${yesterday}）的戀股日誌還沒完成喔～要補一下嗎？（/日誌完成）`);
  } catch (e) { console.error("07:30 backfill error", e); }
}, { timezone: "Asia/Taipei" });

// ====== 服務啟動 ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ orbit07-tg-core listening on ${PORT}`);
});
