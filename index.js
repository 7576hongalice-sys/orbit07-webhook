// index.js — ORBIT07 webhook & broadcaster (Render-ready, CommonJS)
process.env.TZ = process.env.TZ || "Asia/Taipei";

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

// === 掛路由（放在 app.listen 之前） ===
require("./routes-intl")(app);   // 國際盤＋白名單新聞
require("./routes-lists")(app);  // 追蹤清單＋名稱↔代號
require("./routes-tw")(app);     // 台股收盤（TWSE MIS / FinMind）

// ---- ENV ------------------------------------------------------------
const PORT           = parseInt(process.env.PORT || "3000", 10);
const TG_BOT_TOKEN   = process.env.TG_BOT_TOKEN;
const CHAT_ID        = process.env.CHAT_ID || "";
const GROUP_CHAT_ID  = process.env.GROUP_CHAT_ID || "";
const CRON_KEY       = process.env.CRON_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const PARSE_MODE     = process.env.PARSE_MODE || "Markdown";

const VERSION = "2025-08-31-02";

if (!TG_BOT_TOKEN) {
  console.error("❌ TG_BOT_TOKEN 未設定，系統無法發送 Telegram 訊息。");
}
const TG_API = `https://api.telegram.org/bot${TG_BOT_TOKEN}`;

// ---- 工具 -----------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s = "") => String(s).replace(/\uFF5C/g, "|").replace(/\r\n/g, "\n");

function requireKey(req, res) {
  const k = req.headers["x-webhook-key"] || req.headers["x-cron-key"];
  if (!CRON_KEY) { res.status(500).json({ ok:false, error:"server missing CRON_KEY" }); return false; }
  if (!k || k !== CRON_KEY) { res.status(401).json({ ok:false, error:"invalid key" }); return false; }
  return true;
}
function verifyTelegram(req, res) {
  const token = req.headers["x-telegram-bot-api-secret-token"];
  if (!WEBHOOK_SECRET) { res.status(500).json({ ok:false, error:"server missing WEBHOOK_SECRET" }); return false; }
  if (!token || token !== WEBHOOK_SECRET) { res.status(401).json({ ok:false, error:"invalid telegram webhook secret" }); return false; }
  return true;
}

// ---- Telegram 發送 ---------------------------------------------------
async function sendTG(text, chatId, mode = PARSE_MODE, opts = {}) {
  if (!TG_BOT_TOKEN) throw new Error("TG_BOT_TOKEN not set");
  if (!chatId) throw new Error("chat_id is required");

  const url = `${TG_API}/sendMessage`;
  const base = {
    chat_id: chatId, text: norm(text), parse_mode: mode,
    disable_web_page_preview: opts.disable_preview ?? true,
    message_thread_id: opts.thread_id, reply_to_message_id: opts.reply_to,
    allow_sending_without_reply: true, disable_notification: opts.silent ?? false,
  };

  try {
    const { data } = await axios.post(url, base, { timeout: 25000 });
    return data;
  } catch (e) {
    try {
      const { data } = await axios.post(url, { ...base, parse_mode: undefined }, { timeout: 25000 });
      return data;
    } catch (e2) {
      const detail = e2?.response?.data || e?.response?.data || e2?.message || e?.message;
      console.error("sendTG failed:", detail);
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
  }
}
async function sendWithRetry(text, chatId, mode, opts) {
  const backoffs = [0, 1000, 2000, 4000, 8000];
  let lastErr; for (const ms of backoffs) { if (ms) await sleep(ms); try { return await sendTG(text, chatId, mode, opts); } catch (e) { lastErr = e; } }
  throw lastErr;
}

// ---- 健康檢查 -------------------------------------------------------
app.get("/healthz", (_req, res) => {
  res.json({ ok:true, version: VERSION, tz: process.env.TZ, has_token: !!TG_BOT_TOKEN, has_owner: !!CHAT_ID, has_group: !!GROUP_CHAT_ID });
});

// ---- 手動推播 -------------------------------------------------------
app.post("/pub", async (req, res) => {
  if (!requireKey(req, res)) return;
  const { text, target = "group", mode, thread_id, silent, disable_preview } = req.body || {};
  if (!text) return res.status(400).json({ ok:false, error:"text required" });

  try {
    const chat = target === "me" ? CHAT_ID : (GROUP_CHAT_ID || null);
    if (!chat) return res.status(400).json({ ok:false, error: (target === "me" ? "CHAT_ID" : "GROUP_CHAT_ID") + " missing" });

    const r = await sendWithRetry(text, chat, mode, { thread_id, silent, disable_preview });
    res.json({ ok:true, result:r, target });
  } catch (e) {
    res.status(502).json({ ok:false, error:String(e.message || e) });
  }
});

app.post("/broadcast", async (req, res) => {
  if (!requireKey(req, res)) return;
  const { text, to = ["me","group"] } = req.body || {};
  if (!text) return res.status(400).json({ ok:false, error:"text required" });

  const tasks = [];
  if (to.includes("me")) tasks.push(CHAT_ID ? sendWithRetry(text, CHAT_ID) : Promise.reject(new Error("CHAT_ID missing")));
  if (to.includes("group")) tasks.push(GROUP_CHAT_ID ? sendWithRetry(text, GROUP_CHAT_ID) : Promise.reject(new Error("GROUP_CHAT_ID missing")));

  try { const results = await Promise.allSettled(tasks); res.json({ ok:true, results }); }
  catch (e) { res.status(502).json({ ok:false, error:String(e.message || e) }); }
});

// ---- Cron 範例 ------------------------------------------------------
app.post("/cron/morning", async (req, res) => {
  if (!requireKey(req, res)) return;
  if (!GROUP_CHAT_ID) return res.status(400).json({ ok:false, error:"GROUP_CHAT_ID missing" });
  try {
    const text = ["📣 早安提醒","- 這是 /cron/morning 範例訊息。","- 若你看到這則訊息，代表群組推播管道正常運作。"].join("\n");
    const r = await sendWithRetry(text, GROUP_CHAT_ID);
    res.json({ ok:true, result:r });
  } catch (e) { res.status(502).json({ ok:false, error:String(e.message || e) }); }
});

// ---- Telegram Webhook -----------------------------------------------
app.post("/webhook", async (req, res) => {
  if (!verifyTelegram(req, res)) return;
  const update = req.body || {};
  const msg = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
  res.json({ ok:true }); if (!msg) return;

  const chatId = msg.chat?.id; const text = msg.text || msg.caption || ""; const from = msg.from?.username || msg.from?.first_name || "someone";

  try {
    if (/^\/id\b/i.test(text)) {
      const info = [`🆔 chat_id: \`${chatId}\``,`👤 from: ${from}`,`💬 type: ${msg.chat?.type}`].join("\n");
      await sendWithRetry(info, chatId, "Markdown"); return;
    }
    if (/^\/ping\b/i.test(text)) { await sendWithRetry("pong ✅", chatId); return; }
    if (/^\/pub\b/i.test(text)) {
      const payload = text.replace(/^\/pub\s*/i, "");
      if (!payload) { await sendWithRetry("用法：/pub 你的訊息", chatId); return; }
      if (!GROUP_CHAT_ID) { await sendWithRetry("❌ GROUP_CHAT_ID 未設定，無法群播。", chatId); return; }
      await sendWithRetry(`（轉播）${payload}`, GROUP_CHAT_ID);
      await sendWithRetry("已嘗試轉播到群組。", chatId); return;
    }
    if (msg.chat?.type === "private") {
      await sendWithRetry(["👋 指令：","`/id`  取得 chat_id","`/ping` 檢查活性","`/pub <訊息>` 轉播到預設群組"].join("\n"), chatId, "Markdown");
    }
  } catch (e) {
    console.error("webhook handler error:", e?.response?.data || e.message || e);
  }
});

// ---- 啟動 -----------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[ORBIT07] server up on :${PORT}  v${VERSION}`);
});
