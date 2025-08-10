// webhook_server.js — ORBIT07 (A/C + 群組推播 + JSON DB + 全市場查價)
// Node18+ 原生 fetch
const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjsBase.extend(utc); dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

const { addInbox, setSummary, getDay } = require("./db");
const { initSymbols, refreshSymbols, DEFAULT_CACHE } = require("./symbols");

// ===== Env =====
const TOKEN          = process.env.BOT_TOKEN || "";
const OWNER_ID       = Number(process.env.OWNER_ID || 0);
const GROUP_CHAT_ID  = process.env.GROUP_CHAT_ID || "";
const DB_PATH        = process.env.DB_PATH || "/data/lover_stocks.json";
const ANALYZE_MODE   = (process.env.ANALYZE_MODE || "BOTH").toUpperCase(); // A | C | BOTH
const CRON_SUMMARY   = process.env.CRON_SUMMARY || "30 16 * * 1-5";
const SYMBOLS_PATH   = process.env.SYMBOLS_PATH || DEFAULT_CACHE;

if (!TOKEN) console.warn("[WARN] BOT_TOKEN 未設定");
if (!OWNER_ID) console.warn("[WARN] OWNER_ID 未設定（將無法入庫）");
if (!GROUP_CHAT_ID) console.warn("[WARN] GROUP_CHAT_ID 未設定（無法推播到群組）");

const TG_API  = `https://api.telegram.org/bot${TOKEN}`;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== 安全白名單：只放行必要外連 =====
const _fetch = global.fetch;
const ALLOW_HOSTS = new Set([
  "api.telegram.org",      // Telegram
  "mis.twse.com.tw",       // 報價
  "isin.twse.com.tw",      // TWSE 名單
  "www.tpex.org.tw"        // TPEX 名單（若取不到也不影響）
]);
global.fetch = async (url, opts) => {
  const host = (() => { try { return new URL(url).host; } catch { return ""; } })();
  if (!ALLOW_HOSTS.has(host)) {
    console.warn("[BLOCKED OUTBOUND]", host, url);
    throw new Error("Outbound blocked: " + host);
  }
  return _fetch(url, opts);
};

// ===== 工具 =====
const now = () => dayjs().format("YYYY-MM-DD HH:mm:ss");
const ymd = () => dayjs().format("YYYY-MM-DD");
const isWeekday = (d = dayjsBase()) => [1,2,3,4,5].includes(d.day());
function currentMode(d = dayjsBase()) {
  if (!isWeekday(d)) return "C";
  const t = d.tz("Asia/Taipei").format("HH:mm");
  return (t >= "09:00" && t <= "16:30") ? "A" : "C";
}
function isOwner(msg) {
  return msg?.from?.id && Number(msg.from.id) === OWNER_ID;
}

// ===== Telegram 送訊息 =====
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

// ===== UI：常駐鍵盤 =====
function replyKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text:"查價" }, { text:"清單" }, { text:"狀態" }]
      ],
      resize_keyboard: true,
      is_persistent: true
    }
  };
}
const send = (chatId, text) => tgSend(chatId, text, replyKeyboard());

// ===== 連結偵測（內建）=====
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

// ===== 查價：名稱/簡稱/代號皆可 =====
async function fetchTWQuote(code) {
  const ts = Date.now();
  const endpoints = [
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${code}.tw&json=1&_=${ts}`,
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=otc_${code}.tw&json=1&_=${ts}`
  ];
  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers: { "cache-control":"no-cache" } });
      const j = await r.json();
      if (j && j.msgArray && j.msgArray.length) {
        const it = j.msgArray[0];
        if (it.z && it.z !== "-") {
          return {
            ok: true,
            code,
            name: it.n || "",
            open: it.o || "-",
            high: it.h || "-",
            low:  it.l || "-",
            close: it.z,
            date: it.d || dayjs().format("YYYY/MM/DD"),
            market: url.includes("tse_") ? "TWSE" : "TPEX"
          };
        }
      }
    } catch (e) {}
  }
  return { ok:false };
}

// ===== 指令處理 =====
let SYM = null; // symbols 索引
async function ensureSymbols() {
  if (!SYM) SYM = await initSymbols(SYMBOLS_PATH);
  return SYM;
}

async function handleCommand(chatId, t) {
  const text = t.trim();

  if (/^\/start|^\/menu/i.test(text)) {
    return send(chatId, "✅ 機器人上線。直接轉貼含連結的貼文：盤中 A 即時、盤後 C 彙整；查價請輸入「查 2330」或「股價 台積電」。");
  }
  if (text === "狀態" || text === "/狀態") {
    return send(chatId,
`服務：OK
時間：${now()}
模式：${ANALYZE_MODE}（目前：${currentMode(dayjsBase())}）
群組：${GROUP_CHAT_ID || "未設定"}
資料庫：${DB_PATH}
清單：${SYMBOLS_PATH}`);
  }
  if (text === "清單" || text === "/清單") {
    return send(chatId, "（清單功能待補，不影響 A/C 與查價）");
  }

  // /別名 2374 佳能 Canon
  if (/^\/別名\s+/i.test(text)) {
    const m = text.replace(/^\/別名\s+/i, "").trim().split(/\s+/);
    if (m.length < 2) return send(chatId, "格式：/別名 代號 名稱 [更多別名]");
    const [code, ...names] = m;
    const S = await ensureSymbols();
    const ok = await S.addAlias(code, ...names);
    SYM = null; // 重新載入索引
    return send(chatId, ok ? `已新增別名：${code} ← ${names.join("、")}` : "新增別名失敗");
  }

  // 查價：查 2330 / 股價 台積電 / 查 佳能
  let q = null;
  let m1 = text.match(/^\/?(查價|股價|查)\s+(.+)$/);
  if (m1) q = m1[2].trim();
  if (!q && (text === "查價" || text === "/股價")) {
    return send(chatId, "請輸入：查 代號或名稱（例：查 2330、股價 台積電、查 佳能）");
  }
  if (q) {
    const S = await ensureSymbols();
    const hit = S.resolve(q);
    if (!hit) return send(chatId, "查無對應代號/名稱。");
    if (hit.suggest) {
      return send(chatId, `找不到「${q}」，你要查的是：\n• ${hit.suggest.join("\n• ")}`);
    }
    const r = await fetchTWQuote(hit.code);
    if (!r.ok) return send(chatId, `【${hit.code} ${hit.name}】暫無取得到即時/日收資料，稍後再試。`);
    const line =
`【${hit.code} ${hit.name}｜${r.market}】 ${r.date} 收：${r.close}
(開:${r.open} 高:${r.high} 低:${r.low})`;
    return send(chatId, line);
  }

  return send(chatId, `收到：「${text}」`);
}

// ===== 健康檢查 =====
app.get("/healthz", (_req, res) => res.status(200).json({ ok:true, service:"orbit07-webhook", now: now() }));
app.get("/", (_req, res) => res.status(200).json({ ok:true, msg:"alive", now: now() }));

// ===== Webhook：A/C 主流程 =====
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
      // 自然語句：查價/清單/狀態（不以 / 開頭）
      if (/^(查價|股價|查)\s+/.test(text) || text === "查價" || text === "清單" || text === "狀態") {
        await handleCommand(chatId, text);
        return;
      }

      const owner = isOwner(msg);

      // 沒連結就簡短回覆（保持互動）
      if (!links.length && text) {
        await send(chatId, `收到：「${text}」`);
      }
      if (!links.length) return;

      // 入庫（僅 OWNER）
      if (owner && DB_PATH) {
        await addInbox(DB_PATH, ymd(), {
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
        });
      }

      // A 模式：盤中即時推播（僅 OWNER）
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

// ===== C 模式：盤後彙整 → 入庫 summary → 推播 =====
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
      highlights: []
    };
    await setSummary(DB_PATH, today, summary);

    if (GROUP_CHAT_ID) {
      const msg =
`【C 盤後彙整】${today}
收件：${inbox.length} 則
來源TOP：${top_sources.join("，") || "—"}
關注代號：${symbols.join("、") || "—"}
（已寫入戀股資料庫；07:40 可產出盤前導航）`;
      await tgSend(GROUP_CHAT_ID, msg);
    }
  } catch (e) {
    console.error("[C-summary] error", e);
  }
}, { timezone: "Asia/Taipei" });

// ===== 每日 06:00 更新清單快取（TWSE/TPEX 名單）=====
cron.schedule("0 6 * * *", async () => {
  try {
    await refreshSymbols(SYMBOLS_PATH);
    SYM = null;
    console.log("[symbols] refreshed:", SYMBOLS_PATH);
  } catch (e) {
    console.error("[symbols] refresh error", e);
  }
}, { timezone: "Asia/Taipei" });

// ===== Debug：手動刷新/盤後 =====
app.get("/debug/refresh-symbols", async (_req, res) => {
  try {
    await refreshSymbols(SYMBOLS_PATH);
    SYM = null;
    res.json({ ok:true, msg:"refreshed" });
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});
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

// ===== 啟動 =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
