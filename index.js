// === index.js（cron/broadcast + Telegram /webhook 查價 + Markdown回退）===
const express = require("express");
const axios = require("axios");
const fs = require("fs/promises");
const path = require("path");

const Parser = require("rss-parser");
const parser = new Parser();

// ---- ENV ----
const PORT         = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;          // 必填：你的 Telegram Bot Token
const CHAT_ID      = process.env.CHAT_ID;               // /broadcast 預設 chat_id（可空）
const CRON_KEY     = process.env.CRON_KEY || "";        // /cron/* 與 /broadcast 驗證用
const TZ           = process.env.TZ || "Asia/Taipei";
const PARSE_MODE   = process.env.PARSE_MODE || "Markdown";
const SYMBOLS_PATH = process.env.SYMBOLS_PATH || "./symbols.json"; // 全市場別名（可選）

if (!TG_BOT_TOKEN) console.warn("⚠️  TG_BOT_TOKEN 未設定，將無法推播/回覆");
if (!CHAT_ID)      console.warn("⚠️  CHAT_ID 未設定，/broadcast 需要 body.chat_id 或自行指定");

// ---- 基本 HTTP 伺服器 ----
const app = express();
app.use(express.json());

function nowStr(){ return new Date().toLocaleString("zh-TW",{ timeZone: TZ }); }

// ========== 讀取模板（你原本的） ==========
async function readTemplate(name){
  const p = path.join(__dirname,"content",`${name}.txt`);
  try { const t = (await fs.readFile(p,"utf8")||"").trim(); return t||`(${name} 尚無內容)`; }
  catch { return `(${name} 模板讀取失敗或不存在)`; }
}

// ========== 今日頭條（路透RSS） ==========
async function fetchSnapshot() {
  const feeds = [
    "https://feeds.reuters.com/reuters/marketsNews",
    "https://feeds.reuters.com/reuters/worldNews",
    "https://feeds.reuters.com/reuters/businessNews",
    "https://feeds.reuters.com/reuters/technologyNews",
  ];
  const items = [];
  for (const url of feeds) {
    try {
      const d = await parser.parseURL(url);
      items.push(...(d.items || []).slice(0, 3).map(e => `- ${e.title}`));
    } catch (_) {}
  }
  return items.slice(0, 10).join("\n") || "- （暫無頭條）";
}

// ========== Telegram 發送（Markdown → 失敗回退純文字） ==========
async function sendTG(text, chatId, mode){
  if (!TG_BOT_TOKEN) throw new Error("TG_BOT_TOKEN not set");
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const base = { chat_id: chatId||CHAT_ID, text, disable_web_page_preview:true };
  try {
    const { data } = await axios.post(url, { ...base, parse_mode: mode||PARSE_MODE }, { timeout: 25000 });
    return data;
  } catch (e) {
    const { data } = await axios.post(url, base, { timeout: 25000 });
    return data;
  }
}

// ========== 金鑰驗證（cron/broadcast 用） ==========
function verifyKey(req,res){
  const key = req.headers["x-webhook-key"] || req.query.key || "";
  if (!CRON_KEY) return true; // 沒設就不驗
  if (key !== CRON_KEY){ res.status(401).json({ok:false,error:"bad key"}); return false; }
  return true;
}

// 健康檢查
app.get(["/","/health"],(_,res)=>res.send("ok"));

// ========== /broadcast：手動推播 ==========
app.post("/broadcast", async (req,res)=>{
  if(!verifyKey(req,res))return;
  const { text, chat_id, mode } = req.body||{};
  if(!text) return res.status(400).json({ ok:false, error:"text required" });
  try{ res.json({ ok:true, result: await sendTG(text, chat_id, mode) }); }
  catch(e){ console.error("broadcast error:",e?.response?.data||e.message); res.status(500).json({ ok:false, error:e?.response?.data||e.message }); }
});

// ========== /cron/* 四個端點（你原本的） ==========
async function compose(mode){
  const header = {
    morning:"🧭 戀股主場｜盤前導航",
    open:"🚀 戀股主場｜開盤提醒",
    noon:"⏱️ 戀股主場｜午盤小結",
    close:"📊 戀股主場｜收盤小結"
  }[mode] || "📮 推播";

  const tpl = { morning:"preopen", open:"preopen", noon:"noon", close:"close" }[mode] || "preopen";

  const [body, shot] = await Promise.all([ readTemplate(tpl), fetchSnapshot() ]);

  let text = `${header}｜${nowStr()}
——
今日頭條
${shot}

${body}

——
夜辰：記得喝水，紀律比行情重要。`;
  if (text.length > 3900) text = text.slice(0, 3850) + "\n…（已截斷）";
  return text;
}

for (const mode of ["morning","open","noon","close"]){
  app.post(`/cron/${mode}`, async (req,res)=>{
    if(!verifyKey(req,res))return;
    try{ res.json({ ok:true, result: await sendTG(await compose(mode)) }); }
    catch(e){ console.error(`/cron/${mode} error:`,e?.response?.data||e.message); res.status(500).json({ ok:false, error:e?.response?.data||e.message }); }
  });
}

app.post("/cron/ping", async (req,res)=>{
  if(!verifyKey(req,res))return;
  try{ await sendTG(`🔔 測試訊息\n${req.body?.msg||"pong"}\n${nowStr()}`); res.send("pong"); }
  catch(e){ console.error(e?.response?.data||e.message); res.status(500).send("tg error"); }
});

// ========== 全市場查價：代號/名稱/別名 ==========
let SYMBOL_MAP = null;      // { code: "台積電", ... } + 反查
let SYMBOL_MTIME = 0;

const BUILTIN_ALIAS = Object.freeze({
  "2618":"長榮航","長榮航":"2618",
  "5905":"南仁湖","南仁湖":"5905",
  "5202":"力新","力新":"5202",
  "2884":"玉山金","玉山金":"2884",
  "00687B":"國泰20年美債","國泰20年美債":"00687B",
  "00937B":"群益投資級債","群益投資級債":"00937B",
  "2355":"敬鵬","敬鵬":"2355",
  "2374":"佳能","佳能":"2374",
  "1815":"富喬","富喬":"1815",
  "2438":"翔耀","翔耀":"2438",
  "2027":"大成鋼","大成鋼":"2027",
  "2382":"廣達","廣達":"2382",
  "5314":"世紀","世紀":"5314",
  "2330":"台積電","台積電":"2330",
  "2317":"鴻海","鴻海":"2317",
  "3715":"定穎投控","定穎投控":"3715",
});

async function loadSymbolsIfNeeded(){
  try{
    const stat = await fs.stat(SYMBOLS_PATH).catch(()=>null);
    if (!stat) { if (!SYMBOL_MAP) SYMBOL_MAP = {...BUILTIN_ALIAS}; return SYMBOL_MAP; }
    if (!SYMBOL_MAP || stat.mtimeMs !== SYMBOL_MTIME) {
      const raw = await fs.readFile(SYMBOLS_PATH,"utf8").catch(()=> "[]");
      const arr = JSON.parse(raw); // 期待 [{code:"2330", name:"台積電", alias:["台积电","TSMC"]}, ...]
      const map = {...BUILTIN_ALIAS};
      for (const it of arr){
        if (!it || !it.code) continue;
        if (it.name) { map[it.code]=it.name; map[it.name]=it.code; }
        if (Array.isArray(it.alias)) for (const a of it.alias){ if(a){ map[a]=it.code; } }
      }
      SYMBOL_MAP = map;
      SYMBOL_MTIME = stat.mtimeMs;
    }
  }catch{
    if (!SYMBOL_MAP) SYMBOL_MAP = {...BUILTIN_ALIAS};
  }
  return SYMBOL_MAP;
}

function looksLikeCode(s){ return /^[0-9]{4,5}[A-Z]*$/.test(s.toUpperCase()); }

async function resolveSymbol(q){
  const s = String(q||"").trim();
  if (!s) return null;
  const MAP = await loadSymbolsIfNeeded();
  if (looksLikeCode(s)) {
    const name = MAP[s] || "";
    return { code:s.toUpperCase(), name: name || "" };
  }
  const code = MAP[s] || "";
  if (code) return { code, name: s };
  return null;
}

async function fetchTWQuote(code){
  const ts = Date.now();
  const urls = [
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${code}.tw&json=1&_=${ts}`,
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=otc_${code}.tw&json=1&_=${ts}`
  ];
  for (const url of urls){
    try{
      const { data } = await axios.get(url, { timeout: 15000, headers:{ "cache-control":"no-cache" } });
      if (data && data.msgArray && data.msgArray.length){
        const it = data.msgArray[0];
        if (it.z && it.z !== "-"){
          return {
            ok:true,
            code,
            name: it.n || "",
            open: it.o || "-",
            high: it.h || "-",
            low:  it.l || "-",
            close: it.z,
            date: it.d || new Date().toLocaleDateString("zh-TW",{ timeZone: TZ }),
            market: url.includes("tse_") ? "TWSE" : "TPEX"
          };
        }
      }
    }catch(_) {}
  }
  return { ok:false };
}

// ========== Telegram /webhook：/menu + 查價 ==========
function keyboard(){
  return {
    reply_markup:{
      keyboard: [[{text:"查價"},{text:"清單"},{text:"狀態"}]],
      resize_keyboard:true,
      is_persistent:true
    }
  };
}

async function reply(chatId, text){
  return sendTG(text, chatId, PARSE_MODE).catch(()=>sendTG(text, chatId, null));
}

app.post("/webhook", async (req,res)=>{
  res.sendStatus(200);
  try{
    const up = req.body || {};
    const msg = up.message || up.edited_message || up.channel_post || up.edited_channel_post;
    if (!msg?.chat?.id) return;

    const chatId = msg.chat.id;
    const text = (msg.caption || msg.text || "").trim();

    // /menu or /start
    if (/^\/(start|menu)\b/i.test(text)){
      const s = [
        "✅ 我在！可以直接輸入：",
        "• `查 2330` 或 `股價 台積電`",
        "• `查 佳能`（代號/名稱/別名皆可）",
        "",
        "排程推播：仍維持 /cron/* 與 /broadcast。",
      ].join("\n");
      return sendTG(s, chatId, "Markdown");
    }

    // 狀態/清單（保留，暫時簡答）
    if (text === "狀態" || text === "/狀態"){
      const s = `服務：OK
時間：${nowStr()}
symbols：${SYMBOLS_PATH}（若不存在則使用內建別名）`;
      return reply(chatId, s);
    }
    if (text === "清單" || text === "/清單"){
      return reply(chatId, "清單功能之後補強（不影響查價與推播）。");
    }

    // 查價：查 2330 / 股價 台積電 / 查 佳能
    let q = null;
    let m1 = text.match(/^\/?(查價|股價|查)\s+(.+)$/);
    if (m1) q = m1[2].trim();
    if (!q && (text === "查價" || text === "/股價")) {
      return reply(chatId, "請輸入：查 代號或名稱（例：查 2330、股價 台積電、查 佳能）");
    }
    if (q){
      const hit = await resolveSymbol(q);
      if (!hit) return reply(chatId, `查無對應代號/名稱：「${q}」\n可在 ${SYMBOLS_PATH} 加入別名，或用代號再試試。`);
      const r = await fetchTWQuote(hit.code);
      if (!r.ok) return reply(chatId, `【${hit.code} ${hit.name||""}】暫時取不到即時/日收資料，稍後再試。`);
      const line =
`【${hit.code} ${hit.name || r.name}｜${r.market}】 ${r.date} 收：**${r.close}**
(開:${r.open} 高:${r.high} 低:${r.low})`;
      return sendTG(line, chatId, "Markdown");
    }

    // 其他訊息：簡短回覆
    if (text) await reply(chatId, `收到：「${text}」`);
  }catch(e){
    console.error("/webhook error:", e?.response?.data||e.message);
  }
});

app.listen(PORT, ()=>console.log(`orbit07-webhook up on :${PORT}`));
