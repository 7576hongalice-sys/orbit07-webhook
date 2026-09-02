// index.js — ORBIT07 webhook & broadcaster (Render-ready, CommonJS)
process.env.TZ = process.env.TZ || "Asia/Taipei";

const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs/promises");

const app = express();
app.use(express.json({ limit: "1mb" }));

// === 掛路由（務必在 app.listen 之前） ================================
// 既有：
require("./routes-intl")(app);   // 國際盤＋白名單新聞
require("./routes-lists")(app);  // 追蹤清單＋名稱↔代號（含 /watchlist 頁面）
require("./routes-tw")(app);     // 台股收盤（TWSE MIS / FinMind）
// 新增（你要的）：
require("./routes-score")(app);  // ✅ 共振計分＋建議價位
require("./routes-draft")(app);  // ✅ 盤前導航草稿
require("./routes-inst")(app);   // ✅ 上市：TWSE 三大法人
require("./routes-tpex")(app);   // ✅ 上櫃：TPEx 三大法人

// ---- ENV ------------------------------------------------------------
const PORT           = parseInt(process.env.PORT || "3000", 10);
const TG_BOT_TOKEN   = process.env.TG_BOT_TOKEN;
const CHAT_ID        = process.env.CHAT_ID || "";
const GROUP_CHAT_ID  = process.env.GROUP_CHAT_ID || "";
const CRON_KEY       = process.env.CRON_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const PARSE_MODE     = process.env.PARSE_MODE || "Markdown";

const VERSION = "2025-08-31-LI4+WL_CMD+NAME_FIX";

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

// 正式盤前 Stage 1：只讀官方盤後資料並回傳驗證結果，不進行分析或推播。
require("./modules/premarket").mountPremarket(app, { requireKey });

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

// ---- Watchlist I/O（與 /watchlist 頁面共用） ------------------------
const WATCHLIST_FILE = path.join(__dirname, "content", "watchlist.json");
async function readWatchlist() {
  try {
    const txt = await fs.readFile(WATCHLIST_FILE, "utf8");
    const j = JSON.parse(txt);
    if (!Array.isArray(j.self)) j.self = [];
    if (!Array.isArray(j.mom))  j.mom  = [];
    return j;
  } catch {
    return { self: [], mom: [], updatedAt: null };
  }
}
async function writeWatchlist(j) {
  j.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(WATCHLIST_FILE), { recursive: true });
  await fs.writeFile(WATCHLIST_FILE, JSON.stringify(j, null, 2));
  return j;
}

// 名稱/代號解析（走你自己的 lists 路由）
async function resolveSymbol(q) {
  const base = `http://127.0.0.1:${PORT}`;

  // 1) 句子裡包含代號 → 優先視為代號；剩下字當「名稱候選」
  const m = q.match(/\b(\d{4}[A-Z]?)\b/i);
  if (m) {
    const code = m[1].toUpperCase();
    const restName = q.replace(m[0], "").trim(); // 代號拿掉之後的字，當名稱候選

    try {
      const { data } = await axios.get(`${base}/lists/symbol`, { params: { name: code }, timeout: 10000 });
      if (data?.code) {
        return { code: String(data.code), name: data.name || restName || "" };
      }
    } catch {}
    // 查不到也先存代號；若有輸入名稱，順手帶上
    return { code, name: restName || "" };
  }

  // 2) 沒代號 → 先試精確查，後試模糊查
  try {
    const { data } = await axios.get(`${base}/lists/symbol`, { params: { name: q }, timeout: 10000 });
    if (data?.code) return { code: String(data.code), name: data.name || q };
  } catch {}
  try {
    const { data } = await axios.get(`${base}/lists/search`, { params: { q, limit: 5 }, timeout: 10000 });
    const hit = data?.items?.[0];
    if (hit) return { code: String(hit.code || hit.stock_id || hit.id), name: hit.name || hit.stock_name || q };
  } catch {}
  return null;
}

async function upsertWatch(which, code, name = "") {
  const wl = await readWatchlist();
  const arr = which === "mom" ? wl.mom : wl.self;
  const i = arr.findIndex(x => String(x.code) === String(code));
  if (i === -1) arr.push({ code: String(code), name: name || "" });
  else          arr[i] = { code: String(code), name: name || arr[i].name || "" };
  await writeWatchlist(wl);
  return wl;
}
async function removeWatch(which, code) {
  const wl = await readWatchlist();
  const key = which === "mom" ? "mom" : "self";
  wl[key] = wl[key].filter(x => String(x.code) !== String(code));
  await writeWatchlist(wl);
  return wl;
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
  } catch (e) { res.status(502).json({ ok:false, error:String(e.message || e) }); }
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

  const chatId = msg.chat?.id;
  const text = (msg.text || msg.caption || "").trim();
  const from = msg.from?.username || msg.from?.first_name || "someone";

  try {
    // 既有基本指令
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

    // === 新增：/watchlist 斜線指令（與「觀察清單」同功能） ============
    if (/^\/watchlist\b/i.test(text)) {
      const wl = await readWatchlist();
      const me  = wl.self.map(x => `${x.code} ${x.name||""}`.trim()).join("、") || "（空）";
      const mom = wl.mom .map(x => `${x.code} ${x.name||""}`.trim()).join("、") || "（空）";
      await sendWithRetry(
        `📋 觀察：${me}\n👩‍🍼 媽媽：${mom}\n\n🔎 瀏覽器檢視： https://orbit07-webhook.onrender.com/watchlist`,
        chatId, undefined, { disable_preview: false }
      );
      return;
    }

    // === 觀察清單中文指令 =============================================
    let m;

    // 自己清單：加
    if ((m = text.match(/^(?:加觀察|新增觀察|加入觀察)\s+(.+)$/i))) {
      const q = m[1].trim();
      const sym = await resolveSymbol(q);
      if (!sym) { await sendWithRetry(`找不到「${q}」對應的台股代號，請再試一次。`, chatId); return; }
      await upsertWatch("self", sym.code, sym.name);
      await sendWithRetry(`✅ 已加入觀察：${sym.code} ${sym.name||""}\n🔎 檢視：/watchlist`, chatId);
      return;
    }
    // 自己清單：移除
    if ((m = text.match(/^(?:移除觀察|刪除觀察|取消觀察)\s+(.+)$/i))) {
      const q = m[1].trim();
      const sym = await resolveSymbol(q);
      if (!sym) { await sendWithRetry(`找不到「${q}」對應的台股代號，請再試一次。`, chatId); return; }
      await removeWatch("self", sym.code);
      await sendWithRetry(`🗑️ 已移除：${sym.code} ${sym.name||""}\n🔎 檢視：/watchlist`, chatId);
      return;
    }
    // 媽媽清單：加
    if ((m = text.match(/^(?:媽媽追蹤股(?:增加|加)|媽媽加|媽媽追蹤加)\s+(.+)$/i))) {
      const q = m[1].trim();
      const sym = await resolveSymbol(q);
      if (!sym) { await sendWithRetry(`找不到「${q}」對應的台股代號，請再試一次。`, chatId); return; }
      await upsertWatch("mom", sym.code, sym.name);
      await sendWithRetry(`👩‍🍼 已加入媽媽追蹤：${sym.code} ${sym.name||""}\n🔎 檢視：/watchlist`, chatId);
      return;
    }
    // 媽媽清單：移除
    if ((m = text.match(/^(?:媽媽追蹤股(?:移除|刪除)|媽媽移除|媽媽追蹤移除)\s+(.+)$/i))) {
      const q = m[1].trim();
      const sym = await resolveSymbol(q);
      if (!sym) { await sendWithRetry(`找不到「${q}」對應的台股代號，請再試一次。`, chatId); return; }
      await removeWatch("mom", sym.code);
      await sendWithRetry(`🗑️ 已自媽媽追蹤移除：${sym.code} ${sym.name||""}\n🔎 檢視：/watchlist`, chatId);
      return;
    }
    // 查清單（中文口令）
    if (/^(?:觀察清單|媽媽清單)$/i.test(text)) {
      const wl = await readWatchlist();
      const me  = wl.self.map(x => `${x.code} ${x.name||""}`.trim()).join("、") || "（空）";
      const mom = wl.mom .map(x => `${x.code} ${x.name||""}`.trim()).join("、") || "（空）";
      await sendWithRetry(
        `📋 觀察：${me}\n👩‍🍼 媽媽：${mom}\n\n🔎 瀏覽器檢視： https://orbit07-webhook.onrender.com/watchlist`,
        chatId, undefined, { disable_preview: false }
      );
      return;
    }

    // 其他訊息：私聊時回說明
    if (msg.chat?.type === "private") {
      await sendWithRetry(
        [
          "👋 指令：",
          "`/id`  取得 chat_id",
          "`/ping` 檢查活性",
          "`/pub <訊息>` 轉播到預設群組",
          "",
          "📌 追蹤股：",
          "`加觀察 2330`、`移除觀察 2330`",
          "`媽媽追蹤股增加 2603`、`媽媽追蹤股移除 2603`",
          "`觀察清單` 或 `/watchlist` 查看現況",
        ].join("\n"),
        chatId, "Markdown"
      );
    }
  } catch (e) {
    console.error("webhook handler error:", e?.response?.data || e.message || e);
  }
});

// ---- 啟動 -----------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[ORBIT07] server up on :${PORT}  v${VERSION}`);
});
