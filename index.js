// === index.js（Telegram bot + 查價 + 清單增刪 + 盤前兩段 + Gist持久層 + /lists + /watchlist）===
const express = require("express");
const axios = require("axios");
const fs = require("fs/promises");
const path = require("path");
const Parser = require("rss-parser");
const parser = new Parser();

// ---- ENV ----
const PORT         = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;          // 必填
const CHAT_ID      = process.env.CHAT_ID;               // 你的私人視窗
const CRON_KEY     = process.env.CRON_KEY || "";        // /cron/*、/broadcast、/pub、/lists 驗證用
const TZ           = process.env.TZ || "Asia/Taipei";
const PARSE_MODE   = process.env.PARSE_MODE || "Markdown";
const SYMBOLS_PATH = process.env.SYMBOLS_PATH || "./symbols.json"; // 可選

// —— Gist（主持久層，優先）
const GIST_TOKEN    = process.env.GIST_TOKEN || "";
const GIST_ID       = process.env.GIST_ID || "";
const GIST_FILENAME = process.env.GIST_FILENAME || "watchlist.json";

// —— 本機檔（後備持久層；Gist 不可用時才會用）
const LISTS_PATH    = process.env.LISTS_PATH || "./data/lists.json";

// 主人與群組
const OWNER_ID       = Number(process.env.OWNER_ID || 8418229161);     // 你的 TG user id
const GROUP_CHAT_ID  = process.env.GROUP_CHAT_ID || "-4906365799";     // 群組 chat_id（負號開頭）

if (!TG_BOT_TOKEN) console.warn("⚠️  TG_BOT_TOKEN 未設定，將無法推播/回覆");
if (!CHAT_ID)      console.warn("⚠️  CHAT_ID 未設定，/broadcast 需要 body.chat_id 或自行指定");
if (!OWNER_ID)     console.warn("⚠️  OWNER_ID 未設定（發布限制將失效）");
if (!GROUP_CHAT_ID)console.warn("⚠️  GROUP_CHAT_ID 未設定（發布到群組會失敗）");

const app = express();
app.use(express.json());

// ====== 共用小工具 ======
function nowStr(){ return new Date().toLocaleString("zh-TW",{ timeZone: TZ }); }
function todayDateStr(){ return new Date().toLocaleDateString("zh-TW",{ timeZone: TZ }); }
function isTradingWeekday(){
  const d = new Date(new Date().toLocaleString("en-US",{ timeZone: TZ }));
  const wd = d.getDay(); // 0 Sun ... 6 Sat
  return wd >= 1 && wd <= 5;
}

// ====== 模板讀取（保留擴充） ======
async function readTemplate(name){
  const p = path.join(__dirname,"content",`${name}.txt`);
  try { const t = (await fs.readFile(p,"utf8")||"").trim(); return t||`(${name} 尚無內容)`; }
  catch { return `(${name} 模板讀取失敗或不存在)`; }
}

// ====== 今日頭條（路透RSS） ======
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

// ====== TG 發送（Markdown → 失敗回退純文字） ======
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

// ====== 金鑰驗證（cron/broadcast/pub/lists 用） ======
function verifyKey(req,res){
  const key = req.headers["x-webhook-key"] || req.query.key || "";
  if (!CRON_KEY) return true;
  if (key !== CRON_KEY){ res.status(401).json({ok:false,error:"bad key"}); return false; }
  return true;
}

// 健康檢查
app.get(["/","/health","/healthz"],(_,res)=>res.send("ok"));

// ====== 手動推播（保留） ======
app.post("/broadcast", async (req,res)=>{
  if(!verifyKey(req,res))return;
  const { text, chat_id, mode } = req.body||{};
  if(!text) return res.status(400).json({ ok:false, error:"text required" });
  try{ res.json({ ok:true, result: await sendTG(text, chat_id, mode) }); }
  catch(e){ console.error("broadcast error:",e?.response?.data||e.message); res.status(500).json({ ok:false, error:e?.response?.data||e.message }); }
});

// ====== 一鍵發布（POST /pub） ======
app.post("/pub", async (req,res)=>{
  if(!verifyKey(req,res))return;
  try{
    const { text, target = "group", mode } = req.body || {};
    if (!text) return res.status(400).json({ ok:false, error:"text required" });
    const chat = (target === "me") ? CHAT_ID : GROUP_CHAT_ID;
    if (!chat) return res.status(400).json({ ok:false, error:"chat id missing" });
    const r = await sendTG(text, chat, mode || "Markdown");
    res.json({ ok:true, result:r, target });
  }catch(e){
    console.error("/pub error:", e?.response?.data||e.message);
    res.status(500).json({ ok:false, error:e?.response?.data||e.message });
  }
});

// ====== 全市場查價：代號/名稱/別名 ======
let SYMBOL_MAP = null;
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
  "4958":"臻鼎-KY","臻鼎-KY":"4958",
  "3230":"錦明","錦明":"3230",
  "6274":"台燿","台燿":"6274",
  "3211":"順達","順達":"3211",
  "6196":"帆宣","帆宣":"6196",
  "1409":"新纖","新纖":"1409",
  "2402":"毅嘉","毅嘉":"2402",
  "3402":"漢科","漢科":"3402",
});

async function loadSymbolsIfNeeded(){
  try{
    const stat = await fs.stat(SYMBOLS_PATH).catch(()=>null);
    if (!stat) { if (!SYMBOL_MAP) SYMBOL_MAP = {...BUILTIN_ALIAS}; return SYMBOL_MAP; }
    if (!SYMBOL_MAP || stat.mtimeMs !== SYMBOL_MTIME) {
      const raw = await fs.readFile(SYMBOLS_PATH,"utf8").catch(()=> "[]");
      const arr = JSON.parse(raw);
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

// ====== 追蹤清單持久化（B 方案：存 {code,name}；Gist 優先、本機後備） ======
let TRACK_SELF = [
  { code:"2374", name:"佳能" }, { code:"2355", name:"敬鵬" }, { code:"4958", name:"臻鼎-KY" },
  { code:"1409", name:"新纖" }, { code:"5202", name:"力新" }, { code:"1815", name:"富喬" },
  { code:"3230", name:"錦明" }
];
let TRACK_MOM  = [
  { code:"6274", name:"台燿" }, { code:"3211", name:"順達" }, { code:"6196", name:"帆宣" },
  { code:"3402", name:"漢科" }, { code:"2402", name:"毅嘉" }
];
let LISTS_MTIME = 0;

// —— 正規化/格式工具 —— //
function normalizeList(list){
  if (!Array.isArray(list)) return [];
  const out = []; const seen = new Set();
  for (const item of list){
    let code="", name="";
    if (typeof item === "string"){ code = String(item).toUpperCase(); name = BUILTIN_ALIAS[code] || ""; }
    else if (item && item.code){ code = String(item.code).toUpperCase(); name = (item.name||"").trim(); }
    if (!code) continue;
    if (seen.has(code)){
      const i = out.findIndex(x=>x.code===code);
      if (i>=0 && !out[i].name && name) out[i].name = name;
      continue;
    }
    out.push(name ? { code, name } : { code });
    seen.add(code);
  }
  return out;
}
function fmtListLine(item){
  const code = (typeof item === "string") ? item : item.code;
  const name = (typeof item === "object" && item.name) || BUILTIN_ALIAS[code] || "";
  return name ? `${code} ${name}` : `${code}`;
}
function showLists(){
  const a = TRACK_SELF.map(fmtListLine).join("、") || "（無）";
  const b = TRACK_MOM.map(fmtListLine).join("、")  || "（無）";
  return `📌 你的追蹤股：${a}\n💡 媽媽追蹤股：${b}`;
}
// 解析「2402毅嘉 / 多檔」
async function parseEntries(text){
  const cleaned = String(text||"").replace(/[，。、\/\|；;]+/g," ").replace(/\s+/g," ").trim();
  const tokens = cleaned.split(/\s+/).slice(0,50);
  const out = []; const seen = new Set();
  for (let t of tokens){
    let m = t.match(/^(\d{4,5}[A-Z]?)([\u4e00-\u9fa5A-Za-z0-9\-\(\)]*)$/);
    if (m){
      const code = m[1].toUpperCase();
      let name = (m[2]||"").trim() || BUILTIN_ALIAS[code] || "";
      if (!seen.has(code)){ out.push(name?{code,name}:{code}); seen.add(code); }
      continue;
    }
    const hit = await resolveSymbol(t);
    if (hit?.code){
      const code = hit.code.toUpperCase();
      const name = (hit.name && !looksLikeCode(hit.name)) ? hit.name : (BUILTIN_ALIAS[code] || "");
      if (!seen.has(code)){ out.push(name?{code,name}:{code}); seen.add(code); }
    }
  }
  return out;
}
function removeCodesFromList(list, codes){
  const set = new Set(codes.map(c=>String(c).toUpperCase()));
  const before = list.length;
  const after  = list.filter(it => !set.has(typeof it==="string"? it : it.code));
  return { after, removed: before - after.length };
}

// —— 本機檔（後備） —— //
async function fileLoad(){
  const stat = await fs.stat(LISTS_PATH).catch(()=>null);
  if (!stat) return;
  const raw = await fs.readFile(LISTS_PATH,"utf8");
  const j = JSON.parse(raw||"{}");
  if (Array.isArray(j.self)) TRACK_SELF = normalizeList(j.self);
  if (Array.isArray(j.mom))  TRACK_MOM  = normalizeList(j.mom);
  LISTS_MTIME = stat.mtimeMs;
}
async function fileSave(){
  const data = { self: TRACK_SELF, mom: TRACK_MOM, updatedAt: new Date().toISOString() };
  await fs.mkdir(path.dirname(LISTS_PATH), { recursive:true });
  await fs.writeFile(LISTS_PATH, JSON.stringify(data,null,2), "utf8");
  const stat = await fs.stat(LISTS_PATH).catch(()=>null);
  LISTS_MTIME = stat?.mtimeMs || Date.now();
}

// —— Gist（主要） —— //
async function gistGetJson(){
  const url = `https://api.github.com/gists/${GIST_ID}`;
  const { data } = await axios.get(url, {
    timeout: 20000,
    headers: {
      "Authorization": `Bearer ${GIST_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  const file = data.files?.[GIST_FILENAME];
  if (!file) throw new Error(`Gist 檔名不存在：${GIST_FILENAME}`);
  if (file.truncated && file.raw_url){
    const raw = await axios.get(file.raw_url, { timeout: 20000 }).then(r=>r.data);
    return JSON.parse(raw||"{}");
  }
  return JSON.parse(file.content||"{}");
}
async function gistPutJson(obj){
  const url = `https://api.github.com/gists/${GIST_ID}`;
  const body = { files: { [GIST_FILENAME]: { content: JSON.stringify(obj, null, 2) } } };
  await axios.patch(url, body, {
    timeout: 20000,
    headers: {
      "Authorization": `Bearer ${GIST_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
}
async function gistLoad(){
  const j = await gistGetJson().catch(e=>{ console.warn("gistLoad error:", e?.response?.data||e.message); return null; });
  if (j){
    if (Array.isArray(j.self)) TRACK_SELF = normalizeList(j.self);
    if (Array.isArray(j.mom))  TRACK_MOM  = normalizeList(j.mom);
    LISTS_MTIME = Date.now();
  }
}
async function gistSave(){
  const data = { self: TRACK_SELF, mom: TRACK_MOM, updatedAt: new Date().toISOString() };
  try{ await gistPutJson(data); LISTS_MTIME = Date.now(); }
  catch(e){ console.warn("gistSave error:", e?.response?.data||e.message); try{ await fileSave(); }catch{} }
}

// —— 封裝：有 Gist 用 Gist，否則用檔案 —— //
async function loadLists(){ return (GIST_TOKEN && GIST_ID) ? gistLoad() : fileLoad(); }
async function saveLists(){ return (GIST_TOKEN && GIST_ID) ? gistSave() : fileSave(); }

// ====== 07:40 兩階段：組稿 ======
async function composeMorningPhase1(){
  const shot = await fetchSnapshot();
  return `${todayDateStr()} 盤前導航 × 總覽
🌍 國際盤與新聞重點
${shot || "（稍後補充）"}

🏦 三大法人買賣超排行（${todayDateStr()} 前一交易日）
・外資：— 
・投信：—
・自營商：—

🧪 戀股主場 × 五大模組共振分析
・林睿閎：—
・吳岳展：—
・游庭皓：—

🧭 操作建議導航
（待補）

⚠️ 開盤注意事項
（待補）`;
}

async function stockLine(entry){
  const code = (typeof entry === "string") ? entry : entry.code;
  const niceName = (typeof entry === "object" && entry.name) || BUILTIN_ALIAS[code] || "";
  const r = await fetchTWQuote(code);
  const head = `• ${code} ${niceName}｜VWAP：—｜關鍵價：—｜操作/風控：—`;
  if (!r.ok) return `${head}\n  四價：開— 高— 低— 收—`;
  return `${head}\n  四價：開${r.open} 高${r.high} 低${r.low} 收${r.close}`;
}
async function composeMorningPhase2(){
  const linesSelf = await Promise.all(TRACK_SELF.map(stockLine));
  const linesMom  = await Promise.all(TRACK_MOM.map(stockLine));
  return `個股預言 × 四價表（${todayDateStr()}）
📌 你的追蹤股
${linesSelf.join("\n")}

💡 媽媽追蹤股（必分析）
${linesMom.join("\n")}

註：VWAP／關鍵價／操作與風控為佔位，等你提供規則或資料源後自動填入。`;
}

// ====== 07:40 兩階段：端點 ======
app.post("/cron/morning1", async (req,res)=>{
  if(!verifyKey(req,res))return;
  try{
    if (!isTradingWeekday()){
      return res.json({ ok:true, skipped:"weekend" });
    }
    await loadLists(); // 以防外部剛改過
    const text = await composeMorningPhase1();
    const r = await sendTG(text, GROUP_CHAT_ID, "Markdown"); // 固定發群組
    res.json({ ok:true, result:r, target: GROUP_CHAT_ID });
  }catch(e){
    console.error("/cron/morning1 error:", e?.response?.data||e.message);
    res.status(500).json({ ok:false, error:e?.response?.data||e.message });
  }
});

app.post("/cron/morning2", async (req,res)=>{
  if(!verifyKey(req,res))return;
  try{
    if (!isTradingWeekday()){
      return res.json({ ok:true, skipped:"weekend" });
    }
    await loadLists();
    const text = await composeMorningPhase2();
    const previewTarget = CHAT_ID || GROUP_CHAT_ID; // 先給你審
    const r = await sendTG(text, previewTarget, "Markdown");
    res.json({ ok:true, result:r, target: previewTarget });
  }catch(e){
    console.error("/cron/morning2 error:", e?.response?.data||e.message);
    res.status(500).json({ ok:false, error:e?.response?.data||e.message });
  }
});

// 相容端點：/cron/morning（一次觸發兩段）
app.post("/cron/morning", async (req,res)=>{
  if(!verifyKey(req,res))return;
  try{
    if (!isTradingWeekday()){
      return res.json({ ok:true, skipped:"weekend" });
    }
    await loadLists();
    const text1 = await composeMorningPhase1();
    const r1 = await sendTG(text1, GROUP_CHAT_ID, "Markdown");

    const text2 = await composeMorningPhase2();
    const previewTarget = CHAT_ID || GROUP_CHAT_ID;
    const r2 = await sendTG(text2, previewTarget, "Markdown");

    res.json({ ok:true, result:{ phase1:r1, phase2:r2 }, targets:{ phase1: GROUP_CHAT_ID, phase2: previewTarget }});
  }catch(e){
    console.error("/cron/morning error:", e?.response?.data||e.message);
    res.status(500).json({ ok:false, error:e?.response?.data||e.message });
  }
});

// ====== /lists：內部同步（需 key） ======
app.get("/lists", async (req,res)=>{
  if(!verifyKey(req,res))return;
  await loadLists();
  res.json({ self: TRACK_SELF, mom: TRACK_MOM, updatedAt: new Date(LISTS_MTIME||Date.now()).toISOString() });
});

// ====== /watchlist：公開給 GPTs（無驗證） ======
app.get("/watchlist", async (_req,res)=>{
  await loadLists();
  res.json({
    self: TRACK_SELF.map(x=>({ code:x.code, name:x.name||"" })),
    mom:  TRACK_MOM.map(x=>({ code:x.code, name:x.name||"" })),
    updatedAt: new Date(LISTS_MTIME||Date.now()).toISOString()
  });
});

// ====== Telegram /webhook：查價 + 清單增刪 + 發布到群（口令） ======
app.post("/webhook", async (req,res)=>{
  res.sendStatus(200);
  try{
    await loadLists();

    const up = req.body || {};
    const msg = up.message || up.edited_message || up.channel_post || up.edited_channel_post;
    if (!msg?.chat?.id) return;

    const chatId = msg.chat.id;
    const text = (msg.caption || msg.text || "").trim();

    // 只有 OWNER 可用「發布：」把內容轉發到群組（Markdown）
    if (msg.from?.id === OWNER_ID && /^發布[:：]\s*/.test(text) && GROUP_CHAT_ID){
      const payload = text.replace(/^發布[:：]\s*/,"").trim();
      if (payload) { await sendTG(payload, GROUP_CHAT_ID, "Markdown"); }
      return;
    }

    // /start /menu
    if (/^\/(start|menu)\b/i.test(text)){
      const s = [
        "✅ 我在！可以直接輸入：",
        "• `2402` 或 `毅嘉`（不必加「查」）",
        "• 口語：`台積電多少`、`2330股價`",
        "• 也支援：`查 2330`、`股價 台積電`",
        "",
        "清單：`追蹤清單`｜`加觀察 2330台積電`｜`移除觀察 2330`",
        "自然語法：`幫我追蹤 廣達`、`追蹤 2382`、`取消追蹤 2382`",
        "媽媽清單：`媽媽追蹤股增加 2402毅嘉`｜`媽媽追蹤股刪除 2402`",
        "同步：`同步清單`（回傳目前清單與時間）",
        "",
        "07:40 兩段推播：/cron/morning1（自動發群）／/cron/morning2（先發給我看）",
        "舊相容：/cron/morning（兩段都跑）",
        "群組群發口令（限本人）：`發布：<要發到群的全文>`",
      ].join("\n");
      return sendTG(s, chatId, "Markdown");
    }

    // ====== 清單維護（口令 + 自然語法） ======
    const mAddSelf = text.match(/^(?:加觀察|新增觀察)\s+(.+)$/);
    const mDelSelf = text.match(/^(?:移除觀察|刪除觀察)\s+(.+)$/);
    const mAddMom  = text.match(/^(?:媽媽|媽咪)追蹤股(?:增加|新增|加入)\s+(.+)$/);
    const mDelMom  = text.match(/^(?:媽媽|媽咪)追蹤股(?:刪除|移除|取消)\s+(.+)$/);
    const mAddSelf2= text.match(/^我的追蹤股(?:增加|新增|加入)\s+(.+)$/);
    const mDelSelf2= text.match(/^我的追蹤股(?:刪除|移除|取消)\s+(.+)$/);

    // 自然語法
    const mAddSelfNL = text.match(/^(?:幫我)?(?:追蹤|關注|加入觀察)(?:一下)?\s+(.+)$/i);
    const mDelSelfNL = text.match(/^(?:取消|移除)(?:我的)?(?:追蹤|關注|觀察)\s+(.+)$/i);
    const mAddMomNL  = text.match(/^幫(?:我媽|媽媽|媽咪)(?:追蹤|關注|加入觀察)(?:一下)?\s+(.+)$/i);
    const mDelMomNL  = text.match(/^幫(?:我媽|媽媽|媽咪)(?:取消|移除)(?:追蹤|關注|觀察)\s+(.+)$/i);

    async function opAdd(target, payload){
      const entries = await parseEntries(payload);
      const added = [];
      for (const ent of entries){
        if (!target.find(x => x.code === ent.code)){
          target.push(ent.name ? { code: ent.code, name: ent.name } : { code: ent.code });
          added.push(ent);
        }else{
          const i = target.findIndex(x => x.code === ent.code);
          if (i>=0 && !target[i].name && ent.name) target[i].name = ent.name;
        }
      }
      if (added.length) await saveLists();
      return added;
    }
    async function opDel(targetName, payload){
      const entries = await parseEntries(payload);
      const codes = entries.map(e=>e.code);
      if (targetName==="self"){
        const r = removeCodesFromList(TRACK_SELF, codes); TRACK_SELF = r.after; if (r.removed) await saveLists();
      }else{
        const r = removeCodesFromList(TRACK_MOM, codes);  TRACK_MOM  = r.after; if (r.removed) await saveLists();
      }
      return codes;
    }

    if (mAddSelf || mAddSelf2 || mAddSelfNL){
      const added = await opAdd(TRACK_SELF, (mAddSelf?.[1] || mAddSelf2?.[1] || mAddSelfNL?.[1] || "").trim());
      return sendTG(`✅ 已加入觀察：${added.map(fmtListLine).join("、")||"（無變更）"}\n${showLists()}`, chatId, "Markdown");
    }
    if (mDelSelf || mDelSelf2 || mDelSelfNL){
      const codes = await opDel("self", (mDelSelf?.[1] || mDelSelf2?.[1] || mDelSelfNL?.[1] || "").trim());
      return sendTG(`🗑️ 已移除觀察：${codes.map(c=>fmtListLine({code:c})).join("、")||"（無）"}\n${showLists()}`, chatId, "Markdown");
    }
    if (mAddMom || mAddMomNL){
      const added = await opAdd(TRACK_MOM, (mAddMom?.[1] || mAddMomNL?.[1] || "").trim());
      return sendTG(`✅ 媽媽追蹤股已增加：${added.map(fmtListLine).join("、")||"（無變更）"}\n${showLists()}`, chatId, "Markdown");
    }
    if (mDelMom || mDelMomNL){
      const codes = await opDel("mom", (mDelMom?.[1] || mDelMomNL?.[1] || "").trim());
      return sendTG(`🗑️ 媽媽追蹤股已刪除：${codes.map(c=>fmtListLine({code:c})).join("、")||"（無）"}\n${showLists()}`, chatId, "Markdown");
    }

    if (text === "追蹤清單"){
      return sendTG(showLists(), chatId, "Markdown");
    }
    if (text === "同步清單"){
      await loadLists();
      const s = `${showLists()}\n更新時間：${nowStr()}`;
      return sendTG(s, chatId, "Markdown");
    }

    // ====== 查價偵測（指令式 + 直覺式 + 口語式） ======
    let q = null;

    // (A) 指令式
    let m1 = text.match(/^\/?(查價|股價|查)\s+(.+)$/);
    if (m1) q = m1[2].trim();

    // (B) 口語/直覺
    if (!q) {
      const cleaned = text
        .replace(/[，。,\.！？!?～~()\[\]{}【】「」『』：:；;、\s]/g, "")
        .replace(/(股價|價格|多少|幾元|幾塊|報價)$/u, "");
      if (cleaned && cleaned.length <= 12 && /^[\p{L}\p{N}A-Za-z0-9\-]+$/u.test(cleaned)) {
        q = cleaned;
      }
    }

    if (!q && (text === "查價" || text === "/股價")) {
      return sendTG("請直接輸入：`2402`、`毅嘉`、或 `台積電多少`（也可：`查 2330`）", chatId, "Markdown");
    }

    if (q){
      const hit = await resolveSymbol(q);
      if (!hit) return sendTG(`查無對應代號/名稱：「${q}」\n可在 ${SYMBOLS_PATH} 加入別名，或用代號再試試。`, chatId, null);
      const r = await fetchTWQuote(hit.code);
      if (!r.ok) return sendTG(`【${hit.code} ${hit.name||""}】暫時取不到即時/日收資料，稍後再試。`, chatId, null);
      const line =
`【${hit.code} ${hit.name || r.name}｜${r.market}】 ${r.date} 收：*${r.close}*
(開:${r.open} 高:${r.high} 低:${r.low})`;
      return sendTG(line, chatId, "Markdown");
    }

    if (text) await sendTG(`收到：「${text}」`, chatId, null);
  }catch(e){
    console.error("/webhook error:", e?.response?.data||e.message);
  }
});

app.listen(PORT, ()=>console.log(`orbit07-webhook up on :${PORT} (Gist:${GIST_TOKEN && GIST_ID ? 'on' : 'off'})`));
