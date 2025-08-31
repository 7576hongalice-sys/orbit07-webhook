// index.js — ORBIT07 webhook & broadcaster (Render-ready, CommonJS)
process.env.TZ = process.env.TZ || "Asia/Taipei";

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

// === 掛路由（務必在 app.listen 之前） ================================
// 可選：這些檔案若不存在，不要讓服務掛掉
try { require("./routes-intl")(app); } catch {}
try { require("./routes-tw")(app); } catch {}
try { require("./routes-score")(app); } catch {}
try { require("./routes-draft")(app); } catch {}
try { require("./routes-inst")(app); } catch {}
try { require("./routes-tpex")(app); } catch {}
// 必要：清單路由（本次重點）
require("./routes-lists")(app);

// ---- ENV ------------------------------------------------------------
const PORT           = parseInt(process.env.PORT || "3000", 10);
const TG_BOT_TOKEN   = process.env.TG_BOT_TOKEN;
const CHAT_ID        = process.env.CHAT_ID || "";
const GROUP_CHAT_ID  = process.env.GROUP_CHAT_ID || "";
const CRON_KEY       = process.env.CRON_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const PARSE_MODE     = process.env.PARSE_MODE || "Markdown";

const VERSION = "2025-08-31-FULLWATCH-NAMECODE";

// ---- TG 基礎 --------------------------------------------------------
const TG_API = TG_BOT_TOKEN ? `https://api.telegram.org/bot${TG_BOT_TOKEN}` : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm  = (s = "") => String(s).replace(/\uFF5C/g, "|").replace(/\r\n/g, "\n");

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

async function sendTG(text, chatId, mode = PARSE_MODE, opts = {}) {
  if (!TG_API) throw new Error("TG_BOT_TOKEN not set");
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
  let lastErr;
  for (const ms of backoffs) {
    if (ms) await sleep(ms);
    try { return await sendTG(text, chatId, mode, opts); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ---- 名稱→代號解析（FinMind TaiwanStockInfo；快取 6 小時） ---------
const NAME_CACHE = { data: null, ts: 0 };
const SIX_HOURS  = 6 * 60 * 60 * 1000;

function _normName(s) { return String(s||"").replace(/臺/g,"台").trim(); }

async function codeByName(name) {
  const url = "https://api.finmindtrade.com/api/v4/data";
  if (!NAME_CACHE.data || Date.now() - NAME_CACHE.ts > SIX_HOURS) {
    const { data } = await axios.get(url, { params: { dataset: "TaiwanStockInfo" }, timeout: 12000 });
    NAME_CACHE.data = data?.data || [];
    NAME_CACHE.ts   = Date.now();
  }
  const q = _normName(name);
  const rows = NAME_CACHE.data;
  let hit = rows.find(r => _normName(r.stock_name) === q);
  if (!hit) hit = rows.find(r => _normName(r.stock_name).includes(q));
  return hit ? { code: String(hit.stock_id), name: hit.stock_name } : null;
}

async function resolveTokensToCodes(tokens) {
  const out = [];
  for (const raw of tokens) {
    const t = String(raw).trim();
    if (!t) continue;
    // 先抓代號（含 4~6 位數；容許括號內）
    const m = t.match(/\d{4,6}/);
    if (m) { out.push(m[0]); continue; }
    // 再用名稱查
    const r = await codeByName(t);
    if (r?.code) out.push(r.code);
  }
  return Array.from(new Set(out));
}
const baseUrl = (req) => `${req.protocol}://${req.get("host")}`;

// ---- 健康檢查 -------------------------------------------------------
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true, version: VERSION, tz: process.env.TZ,
    has_token: !!TG_BOT_TOKEN, has_owner: !!CHAT_ID, has_group: !!GROUP_CHAT_ID
  });
});

// ---- 發送工具 -------------------------------------------------------
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
  if (to.includes("me"))   tasks.push(CHAT_ID ? sendWithRetry(text, CHAT_ID) : Promise.reject(new Error("CHAT_ID missing")));
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

// ---- Telegram Webhook（含「中文口令」→ 呼叫 /lists API） -----------
app.post("/webhook", async (req, res) => {
  if (!verifyTelegram(req, res)) return;
  const upd = req.body || {};
  const msg = upd.message || upd.edited_message || upd.channel_post || upd.edited_channel_post;

  res.json({ ok: true });
  if (!msg) return;

  const chatId = msg.chat?.id;
  const text   = (msg.text || msg.caption || "").trim();
  const from   = msg.from?.username || msg.from?.first_name || "someone";

  try {
    // 基本指令
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

    // === 觀察清單中文口令（代號或名稱；可一次多個，以空白/逗號分隔） ===
    let m;

    // 自己清單：加
    if ((m = text.match(/^(?:加觀察|新增觀察|加入觀察)\s+(.+)$/i))) {
      const tokens = m[1].split(/[,\s]+/);
      const codes  = await resolveTokensToCodes(tokens);
      if (!codes.length) { await sendWithRetry("請提供代號或名稱，例如：加觀察 2330 台積電 廣達", chatId); return; }
      await axios.get(`${baseUrl(req)}/lists/add`, { params: { chat_id: chatId, codes: codes.join(","), bucket: "user" }, timeout: 10000 });
      await sendWithRetry(`✅ 已加入觀察：${codes.join(", ")}`, chatId);
      return;
    }

    // 自己清單：移除
    if ((m = text.match(/^(?:移除觀察|刪除觀察|取消觀察)\s+(.+)$/i))) {
      const tokens = m[1].split(/[,\s]+/);
      const codes  = await resolveTokensToCodes(tokens);
      if (!codes.length) { await sendWithRetry("請提供代號或名稱，例如：移除觀察 2330 台積電", chatId); return; }
      await axios.get(`${baseUrl(req)}/lists/remove`, { params: { chat_id: chatId, codes: codes.join(","), bucket: "user" }, timeout: 10000 });
      await sendWithRetry(`🗑️ 已移除：${codes.join(", ")}`, chatId);
      return;
    }

    // 媽媽清單：加
    if ((m = text.match(/^(?:媽媽追蹤股(?:增加|加)|媽媽加|媽媽追蹤加)\s+(.+)$/i))) {
      const tokens = m[1].split(/[,\s]+/);
      const codes  = await resolveTokensToCodes(tokens);
      if (!codes.length) { await sendWithRetry("請提供代號或名稱，例如：媽媽追蹤股增加 2402 毅嘉", chatId); return; }
      await axios.get(`${baseUrl(req)}/lists/add`, { params: { chat_id: chatId, codes: codes.join(","), bucket: "mama" }, timeout: 10000 });
      await sendWithRetry(`👩‍🍼 已加入媽媽追蹤：${codes.join(", ")}`, chatId);
      return;
    }

    // 媽媽清單：移除
    if ((m = text.match(/^(?:媽媽追蹤股(?:移除|刪除)|媽媽移除|媽媽追蹤移除)\s+(.+)$/i))) {
      const tokens = m[1].split(/[,\s]+/);
      const codes  = await resolveTokensToCodes(tokens);
      if (!codes.length) { await sendWithRetry("請提供代號或名稱，例如：媽媽追蹤股移除 2402 毅嘉", chatId); return; }
      await axios.get(`${baseUrl(req)}/lists/remove`, { params: { chat_id: chatId, codes: codes.join(","), bucket: "mama" }, timeout: 10000 });
      await sendWithRetry(`🗑️ 已自媽媽追蹤移除：${codes.join(", ")}`, chatId);
      return;
    }

    // 查清單（給一鍵查看連結）
    if (/^(?:觀察清單|媽媽清單)$/i.test(text)) {
      await sendWithRetry(
        `🔎 檢視清單：${baseUrl(req)}/lists/watch?chat_id=${chatId}&format=md`,
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
          "📌 追蹤股（可一次多檔，代號或名稱）",
          "`加觀察 2330 台積電 廣達`",
          "`移除觀察 2330 台積電`",
          "`媽媽追蹤股增加 2402 毅嘉` / `媽媽追蹤股移除 2402`",
          "`觀察清單` 檢視現況",
        ].join("\n"),
        chatId, "Markdown"
      );
    }
  } catch (e) {
    console.error("webhook handler error:", e?.response?.data || e.message || e);
  }
});

// ---- 別名：/watchlist → /lists/watch?format=json&chat_id=... ---------
app.get("/watchlist", async (req, res) => {
  try {
    const chat_id = (req.query.chat_id || "").trim();
    if (!chat_id) return res.status(400).json({ ok:false, error:"chat_id required" });
    const url = `${req.protocol}://${req.get("host")}/lists/watch?format=json&chat_id=${encodeURIComponent(chat_id)}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    res.json(data);
  } catch (e) {
    res.status(502).json({ ok:false, error: String(e?.message || e) });
  }
});

// ---- 啟動 -----------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[ORBIT07] server up on :${PORT}  v${VERSION}`);
});
