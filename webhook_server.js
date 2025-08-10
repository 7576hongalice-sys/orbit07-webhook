// webhook_server.js — ORBIT07 (A/C 模式 + 群組推播 + JSON DB)
// Node 18+（原生 fetch）
const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjsBase.extend(utc); dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

const { addInbox, setSummary, getDay } = require("./db");

// ===== 必填環境變數 =====
// BOT_TOKEN：Telegram 機器人 Token
// OWNER_ID：只有這個使用者的貼文才寫入資料庫（範例：8418229161）
// GROUP_CHAT_ID：推播的群組（如：-1002297543448）
// DB_PATH：資料庫 JSON 路徑（例：/data/lover_stocks.json）
// 可選：ANALYZE_MODE=BOTH/A/C；CRON_SUMMARY="30 16 * * 1-5"
const TOKEN          = process.env.BOT_TOKEN || "";
const OWNER_ID       = Number(process.env.OWNER_ID || 0);
const GROUP_CHAT_ID  = process.env.GROUP_CHAT_ID || "";
const DB_PATH        = process.env.DB_PATH || "/data/lover_stocks.json";
const ANALYZE_MODE   = (process.env.ANALYZE_MODE || "BOTH").toUpperCase(); // A | C | BOTH
const CRON_SUMMARY   = process.env.CRON_SUMMARY || "30 16 * * 1-5";

if (!TOKEN) console.warn("[WARN] BOT_TOKEN 未設定");
if (!OWNER_ID) console.warn("[WARN] OWNER_ID 未設定（將無法入庫）");
if (!GROUP_CHAT_ID) console.warn("[WARN] GROUP_CHAT_ID 未設定（無法推播到群組）");

const TG_API  = `https://api.telegram.org/bot${TOKEN}`;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== 小工具 =====
const now = () => dayjs().format("YYYY-MM-DD HH:mm:ss");
const ymd = () => dayjs().format("YYYY-MM-DD");
const isWeekday = (d = dayjsBase()) => [1,2,3,4,5].includes(d.day());
function currentMode(d = dayjsBase()) {
  if (!isWeekday(d)) return "C"; // 週末統一走盤後
  const t = d.tz("Asia/Taipei").format("HH:mm");
  return (t >= "09:00" && t <= "16:30") ? "A" : "C";
}
function isOwner(msg) {
  return msg?.from?.id && Number(msg.from.id) === OWNER_ID;
}

// 只允許打 Telegram API（保險，避免誤連外造成費用）
const _fetch = global.fetch;
const ALLOW_HOSTS = new Set(["api.telegram.org"]);
global.fetch = async (url, opts) => {
  const host = (() => { try { return new URL(url).host; } catch { return ""; } })();
  if (!ALLOW_HOSTS.has(host)) {
    console.warn("[BLOCKED OUTBOUND]", host, url);
    throw new Error("Outbound blocked: " + host);
  }
  return _fetch(url, opts);
};

// 發訊
async function tgSend(chatId, text, extra = {}) {
  if (!TOKEN) return;
  try {
    const r = await fetch(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...extra })
    });
    const j = await r.json().catch(()=> ({}));
    if (!j.ok) console.error("[tgSend] fail:", j);
    return j;
  } catch (e) { console.error("[tgSend] err", e); }
}

// 常駐鍵盤（精簡）
function replyKeyboard() {
  return {
    reply_markup: {
      keyboard: [[{ text:"查價" }, { text:"清單" }, { text:"狀態" }]],
      resize_keyboard: true,
      is_persistent: true
    }
  };
}
const send = (chatId, text) => tgSend(chatId, text, replyKeyboard());

// ====== 連結/轉貼偵測（內建，不再分檔）======
function extractLinks(text = "", entities = []) {
  const urls = [];
  for (const e of entities || []) {
    if (e.type === "text_link" && e.url) urls.push(e.url);
    if (e.type === "url") urls.push(text.substring(e.offset, e.offset + e.length));
  }
  const re = /https?:\/\/[^\s]+/gi;
  for (const m of text.match(re) || []) if (!urls.includes(m)) urls.push(m);
  return urls;
}
function detectForward(msg) {
  if (msg.forward_from_chat?.title) return `FWD: ${msg.forward_from_chat.title}`;
  if (msg.forward_origin?.chat?.title) return `FWD: ${msg.forward_origin.chat.title}`;
  return "原貼";
}
function summarizeLinkPreview(text, links) {
  const codes = Array.from(new Set((text.match(/\b\d{4,5}[A-Z]?\b/g) || []))).slice(0,8);
  const head  = text.split(/\r?\n/).filter(Boolean).slice(0,2).join(" / ");
  const ls    = links.slice(0,3).join("\n");
  return { codes, head, ls };
}

// ====== 指令處理（保留最小）======
async function handleCommand(chatId, t) {
  const text = t.trim();
  if (/^\/start|^\/menu/i.test(text)) {
    return send(chatId, "✅ 機器人上線。直接轉貼連結，我會依時間自動套用 A/C 模式。");
  }
  if (text === "狀態" || text === "/狀態") {
    return send(chatId,
`服務：OK
時間：${now()}
模式：${ANALYZE_MODE}（動態時間窗：${currentMode(dayjsBase())}）
群組：${GROUP_CHAT_ID || "未設定"}
資料庫：${DB_PATH}`);
  }
  if (text === "清單" || text === "/清單") {
    return send(chatId, "清單功能之後接（不影響 A/C 模式）。");
  }
  if (text === "查價" || /^\/查價|^股價/.test(text)) {
    return send(chatId, "查價之後接（不影響 A/C 模式）。");
  }
  return send(chatId, `收到：「${text}」`);
}

// ====== Health ======
app.get("/healthz", (_req, res) =>
  res.status(200).json({ ok:true, service:"orbit07-webhook", now: now() })
);
app.get("/", (_req, res) =>
  res.status(200).json({ ok:true, msg:"alive", now: now() })
);

// ====== Webhook：A/C 模式主流程 ======
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  (async () => {
    try {
      const up = req.body || {};
      const msg = up.message || up.edited_message || up.channel_post || up.edited_channel_post;
      if (!msg?.chat?.id) return;

      const chatId = String(msg.chat.id);
      const text   = (msg.caption || msg.text || "").trim();
      const entities = msg.entities || msg.caption_entities || [];
      const links  = extractLinks(text, entities);
      const source = detectForward(msg);

      // 指令
      if (text?.startsWith("/")) {
        await handleCommand(chatId, text);
        return;
      }

      // 只有 OWNER 才入庫/推播（其他人：可改成回覆未授權）
      const owner = isOwner(msg);

      // —— 先回基本互動，避免你等不到反饋 ——
      if (!links.length && text) {
        await send(chatId, `收到：「${text}」`);
      }

      // 不含連結就不做 A/C 邏輯（你要也可改）
      if (!links.length) return;

      // 今日入庫（僅 OWNER）
      if (owner && DB_PATH) {
        const item = {
          ts: dayjs().format("YYYY-MM-DD HH:mm"),
          mode: currentMode(dayjsBase()),
          from_id: Number(msg.from.id),
          chat_id: Number(GROUP_CHAT_ID || chatId),
          source,
          text: text.split(/\r?\n/).slice(0,6).join("\n"),
          links,
          symbols: Array.from(new Set((text.match(/\b\d{4,5}[A-Z]?\b/g) || []))).slice(0,12),
          tags: /法說|上修|下修|營收|展望|調降/.test(text) ? ["事件"] : [],
          media: { photo: !!msg.photo, video: !!msg.video }
        };
        await addInbox(DB_PATH, ymd(), item);
      }

      // A 模式：盤中即時推播到群組（僅 OWNER）
      const wantA = ANALYZE_MODE === "A" || ANALYZE_MODE === "BOTH";
      const inAWindow = currentMode(dayjsBase()) === "A";
      if (owner && wantA && inAWindow && GROUP_CHAT_ID) {
        const { codes, head, ls } = summarizeLinkPreview(text, links);
        const body =
`【A 即時】${dayjs().format("HH:mm")}
來源：${source}
重點：${head || "（無文字）"}
代號：${codes.join("、") || "無"}
連結：
${ls || "無"}`;
        await tgSend(GROUP_CHAT_ID, body);
      }

    } catch (e) {
      console.error("[/webhook] error", e);
    }
  })();
});

// ====== C 模式：16:30 盤後彙整 → 寫回資料庫 → 推播到群組 ======
cron.schedule(CRON_SUMMARY, async () => {
  try {
    const today = ymd();
    const data = await getDay(DB_PATH, today);
    const inbox = (data.inbox || []).filter(it => it.from_id === OWNER_ID);
    if (!inbox.length) return;

    const bySrc = {};
    const symbolSet = new Set();
    inbox.forEach(it => {
      bySrc[it.source] = (bySrc[it.source] || 0) + 1;
      for (const s of (it.symbols || [])) symbolSet.add(s);
    });
    const top_sources = Object.entries(bySrc).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${k} x${v}`);
    const symbols = Array.from(symbolSet).slice(0,20);

    const summary = {
      at: dayjs().format("YYYY-MM-DD HH:mm"),
      items: inbox.length,
      top_sources,
      symbols,
      highlights: [] // 之後接規則/模型產生重點句
    };
    await setSummary(DB_PATH, today, summary);

    if (GROUP_CHAT_ID) {
      const msg =
`【C 盤後彙整】${today}
收件：${inbox.length} 則
來源TOP：${top_sources.join("，") || "—"}
關注代號：${symbols.join("、") || "—"}
（已寫入戀股資料庫；可於 07:40 產出盤前導航）`;
      await tgSend(GROUP_CHAT_ID, msg);
    }
  } catch (e) {
    console.error("[C-summary] error", e);
  }
}, { timezone: "Asia/Taipei" });

// ====== （可選）手動觸發彙整：瀏覽器打 /debug/run-summary ======
app.get("/debug/run-summary", async (_req, res) => {
  try {
    const today = ymd();
    const data = await getDay(DB_PATH, today);
    const inbox = (data.inbox || []).filter(it => it.from_id === OWNER_ID);
    if (!inbox.length) return res.json({ ok:true, msg:"今天 inbox 是空的" });

    const bySrc = {};
    const symbolSet = new Set();
    inbox.forEach(it => {
      bySrc[it.source] = (bySrc[it.source] || 0) + 1;
      for (const s of (it.symbols || [])) symbolSet.add(s);
    });
    const top_sources = Object.entries(bySrc).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${k} x${v}`);
    const symbols = Array.from(symbolSet).slice(0,20);

    const summary = {
      at: dayjs().format("YYYY-MM-DD HH:mm"),
      items: inbox.length,
      top_sources,
      symbols
    };
    await setSummary(DB_PATH, today, summary);
    res.json({ ok:true, saved: summary });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// ====== 啟動 ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
