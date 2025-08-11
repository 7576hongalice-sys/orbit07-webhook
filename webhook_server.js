// webhook_server.js — ORBIT07 Cloud (Render): A/C + 盤前導航 + 群組推播 + JSON DB + 查價修復
const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjsBase.extend(utc); dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

const { addInbox, setSummary, getDay } = require("./db");
const { initSymbols, refreshSymbols, DEFAULT_CACHE } = require("./symbols");
const { getDailyClose } = require("./close_providers");

// ===== Cloud Envs (Render 後台設定) =====
const TOKEN          = process.env.BOT_TOKEN || "";
const OWNER_ID       = Number(process.env.OWNER_ID || 0);
const GROUP_CHAT_ID  = process.env.GROUP_CHAT_ID || "";             // -100xxxxxxxxxx（群組），或留空只私訊
const DB_PATH        = process.env.DB_PATH || "/data/inbox.json";
const ANALYZE_MODE   = (process.env.ANALYZE_MODE || "BOTH").toUpperCase(); // A | C | BOTH
const CRON_SUMMARY   = process.env.CRON_SUMMARY || "30 16 * * 1-5";        // 盤後彙整
const SYMBOLS_PATH   = process.env.SYMBOLS_PATH || DEFAULT_CACHE;
const PREMARKET_CRON = process.env.PREMARKET_CRON || "15 7 * * 1-5";       // 盤前導航 07:15
const PORT           = process.env.PORT || 3000;

if (!TOKEN) console.warn("[WARN] BOT_TOKEN 未設定");
if (!OWNER_ID) console.warn("[WARN] OWNER_ID 未設定（將無法入庫）");
if (!GROUP_CHAT_ID) console.warn("[WARN] GROUP_CHAT_ID 未設定（群組推播停用）");

const TG_API  = `https://api.telegram.org/bot${TOKEN}`;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== 僅允許必要對外主機 =====
const _fetch = global.fetch;
const ALLOW_HOSTS = new Set([
  "api.telegram.org",
  "mis.twse.com.tw",
  "isin.twse.com.tw",
  "www.twse.com.tw",
  "www.tpex.org.tw",
  "tpex.org.tw"
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
function isOwner(msg) { return msg?.from?.id && Number(msg.from.id) === OWNER_ID; }

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

function replyKeyboard() {
  return { reply_markup: { keyboard: [[{ text:"查價" }, { text:"清單" }, { text:"狀態" }]], resize_keyboard: true, is_persistent: true } };
}
const send = (chatId, text) => tgSend(chatId, text, replyKeyboard());

// ===== 文字/連結處理 =====
function normInput(s = "") {
  return String(s).replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, " ")
                  .replace(/\s+/g, " ").trim();
}
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

// ===== MIS 即時 + 日收盤備援 =====
async function fetchTWQuote(code) {
  const ts = Date.now();
  const endpoints = [
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${code}.tw&json=1&_=${ts}`,
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=otc_${code}.tw&json=1&_=${ts}`
  ];
  let marketTried = null;
  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers: { "cache-control":"no-cache" } });
      const j = await r.json();
      if (j && j.msgArray && j.msgArray.length) {
        const it = j.msgArray[0];
        marketTried = url.includes("tse_") ? "TWSE" : "TPEx";
        if (it.z && it.z !== "-") {
          return {
            ok: true, code, name: it.n || "",
            open: it.o || "-", high: it.h || "-", low: it.l || "-",
            close: it.z, date: it.d || dayjs().format("YYYY/MM/DD"),
            market: marketTried
          };
        }
      }
    } catch (e) {}
  }
  const daily = await getDailyClose(code, marketTried);
  if (daily) return { ok:true, code, name:"", ...daily };
  return { ok:false };
}

// ===== 指令處理 =====
let SYM = null;
async function ensureSymbols() { if (!SYM) SYM = await initSymbols(SYMBOLS_PATH); return SYM; }

function renderPremarket({ date, summary, watchlist=[] }) {
  const intl = (summary?.intl || []).map(s=>`  • ${s}`).join("\n") || "  • —";
  const chips = summary?.chips || {};
  const c1 = (chips.foreign_top_buy||[]).join("、") || "—";
  const c2 = (chips.inv_trust_top_buy||[]).join("、") || "—";
  const c3 = (chips.dealer_top_buy||[]).join("、") || "—";
  const nav = (summary?.nav || []).map(s=>`  • ${s}`).join("\n") || "  • —";
  const wl  = (watchlist||[]).map(w=>`  • ${w.code} ${w.name || ""}：${w.reason || ""}`.trim()).join("\n") || "  • —";
  return `【盤前重點 × 操作導航｜${date}】
- 國際盤：
${intl}
- 三大法人觀察：
  • 外資 Top Buy：${c1}
  • 投信 Top Buy：${c2}
  • 自營 Top Buy：${c3}
- 操作導航：
${nav}
- 你的關注：
${wl}
（輸入 /price 2330 查價；/狀態 看服務）`;
}

async function handleCommand(chatId, t) {
  const text = normInput(t);

  if (/^\/echo\b/i.test(text)) {
    const raw = t ?? "";
    const codes = Array.from(raw).map(ch => ch.charCodeAt(0).toString(16).padStart(4,"0"));
    return send(chatId, `RAW:${JSON.stringify(raw)}\nNORM:${JSON.stringify(text)}\nCODES:${codes.join(" ")}`);
  }
  if (/^\/start|^\/menu/i.test(text)) {
    return send(chatId, "✅ 機器人上線。查價：輸入「查 2330」或「股價 台積電」。");
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
  if (text === "清單" || text === "/清單") return send(chatId, "（清單功能待補）");

  if (/^\/today$/i.test(text)) {
    const todayISO = ymd();
    const yestISO  = dayjs().subtract(1, "day").format("YYYY-MM-DD");
    const yData    = await getDay(DB_PATH, yestISO) || {};
    const symbols  = (yData.summary?.symbols || []).slice(0, 10);
    const watchlist = symbols.map(code => ({ code, reason: "昨日關注" }));
    const payload = {
      date: todayISO,
      summary: { intl: yData.intl || [], chips: yData.chips || {}, nav: [
        "9:15～9:30 觀察量能是否放大",
        "弱勢不抄、強勢回測可接",
      ]},
      watchlist
    };
    return send(chatId, renderPremarket(payload));
  }

  // 查價：容忍零寬/全形/斜線前綴
  let q = null;
  let m1 = text.match(/^[\u200B-\u200D\uFEFF\s/]*(查價|股價|查)\s+(.+)$/i);
  if (m1) q = m1[2].trim();
  const fallbackCode = !q ? (text.match(/\b\d{4,5}[A-Z]?\b/) || [])[0] : null;

  if (!q && (text === "查價" || text === "/股價")) {
    return send(chatId, "請輸入：查 代號或名稱（例：查 2330、股價 台積電、查 佳能）");
  }
  if (q || fallbackCode) {
    const S = await ensureSymbols();
    const hit = q ? S.resolve(q) : S.resolve(fallbackCode);
    if (!hit) return send(chatId, "查無對應代號/名稱。");
    if (hit.suggest) return send(chatId, `找不到「${q||fallbackCode}」，你要查的是：\n• ${hit.suggest.join("\n• ")}`);
    const r = await fetchTWQuote(hit.code);
    if (!r.ok) return send(chatId, `【${hit.code} ${hit.name || ""}】暫無取得到即時/日收資料，稍後再試。`);
    const showName = r.name || hit.name || "";
    const line = `【${hit.code} ${showName}｜${r.market}】 ${r.date} 收：${r.close}\n(開:${r.open} 高:${r.high} 低:${r.low})`;
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
      const text   = normInput(msg.caption || msg.text || "");
      const entities = msg.entities || msg.caption_entities || [];
      const links  = extractLinks(text, entities);
      const source = detectForward(msg);

      if (text?.startsWith("/")) { await handleCommand(chatId, text); return; }
      if (/^[\u200B-\u200D\uFEFF\s/]*(查價|股價|查)\s+/.test(text) || ["查價","清單","狀態"].includes(text)) {
        await handleCommand(chatId, text); return;
      }

      const owner = isOwner(msg);
      if (!links.length && text) await send(chatId, `收到：「${text}」`);
      if (!links.length) return;

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

      const wantA = ANALYZE_MODE === "A" || ANALYZE_MODE === "BOTH";
      const inAWindow = currentMode(dayjsBase()) === "A";
      if (owner && wantA && inAWindow && GROUP_CHAT_ID) {
        const { codes, head, ls } = summarizeLinkPreview(text, links);
        const body = `【A 即時】${dayjs().format("HH:mm")}\n來源：${source}\n重點：${head || "（無文字）"}\n代號：${codes.join("、") || "無"}\n連結：\n${ls || "無"}`;
        await tgSend(GROUP_CHAT_ID, body);
      }
    } catch (e) { console.error("[/webhook] error", e); }
  })();
});

// ===== C 模式：盤後彙整 =====
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

    const summary = { at: dayjs().format("YYYY-MM-DD HH:mm"), items: inbox.length, top_sources, symbols, highlights: [] };
    await setSummary(DB_PATH, today, summary);

    if (GROUP_CHAT_ID) {
      const msg = `【C 盤後彙整】${today}\n收件：${inbox.length} 則\n來源TOP：${top_sources.join("，") || "—"}\n關注代號：${symbols.join("、") || "—"}\n（已寫入戀股資料庫；07:15 會送出盤前導航）`;
      await tgSend(GROUP_CHAT_ID, msg);
    }
  } catch (e) { console.error("[C-summary] error", e); }
}, { timezone: "Asia/Taipei" });

// ===== 每日 06:00 更新清單快取 =====
cron.schedule("0 6 * * *", async () => {
  try { await refreshSymbols(SYMBOLS_PATH); SYM = null; console.log("[symbols] refreshed:", SYMBOLS_PATH); }
  catch (e) { console.error("[symbols] refresh error", e); }
}, { timezone: "Asia/Taipei" });

// ===== 盤前導航：07:15 =====
cron.schedule(PREMARKET_CRON, async () => {
  try {
    if (!isWeekday(dayjsBase())) return;
    if (!GROUP_CHAT_ID) return;

    const todayISO = ymd();
    const yestISO  = dayjs().subtract(1, "day").format("YYYY-MM-DD");
    const yData    = await getDay(DB_PATH, yestISO) || {};
    const symbols  = (yData.summary?.symbols || []).slice(0, 10);
    const watchlist = symbols.map(code => ({ code, reason: "昨日關注" }));

    const payload = {
      date: todayISO,
      summary: { intl: yData.intl || [], chips: yData.chips || {}, nav: [
        "9:15～9:30 觀察量能是否放大",
        "弱勢不抄、強勢回測可接",
      ]},
      watchlist
    };
    await tgSend(GROUP_CHAT_ID, renderPremarket(payload));
    console.log("[premarket] sent", todayISO);
  } catch (e) { console.error("[premarket] error", e); }
}, { timezone: "Asia/Taipei" });

// ===== Debug 路由 =====
app.get("/healthz", (_req, res) => res.status(200).json({ ok:true, service:"orbit07-webhook", now: now() }));
app.get("/debug/refresh-symbols", async (_req, res) => {
  try { await refreshSymbols(SYMBOLS_PATH); SYM = null; res.json({ ok:true, msg:"refreshed" }); }
  catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});
app.get("/debug/run-summary", async (_req, res) => {
  try {
    const today = ymd();
    const data = await getDay(DB_PATH, today);
    const inbox = (data.inbox || []).filter(it => it.from_id === OWNER_ID);
    if (!inbox.length) return res.json({ ok:true, msg:"今天 inbox 是空的" });
    const bySrc = {}; const symbolSet = new Set();
    inbox.forEach(it => { bySrc[it.source] = (bySrc[it.source]||0)+1; for (const s of (it.symbols||[])) symbolSet.add(s); });
    const top_sources = Object.entries(bySrc).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${k} x${v}`);
    const symbols = Array.from(symbolSet).slice(0,20);
    const summary = { at: dayjs().format("YYYY-MM-DD HH:mm"), items: inbox.length, top_sources, symbols };
    await setSummary(DB_PATH, today, summary);
    res.json({ ok:true, saved: summary });
  } catch (e) { res.status(500).json({ ok:false, error: String(e) }); }
});
app.get("/debug/price", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    if (!code) return res.status(400).json({ ok:false, error:"code required" });
    const out = await fetchTWQuote(code);
    res.json(out);
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
