// === index.js（cron/broadcast + Telegram /webhook 查價(直覺輸入) + 07:40 兩段推播
// + 一鍵發布 + 相容 /cron/morning + 追蹤清單口令/持久化 + /lists API）===

const express = require("express");
const axios = require("axios");
const fs = require("fs/promises");
const path = require("path");

const Parser = require("rss-parser");
const parser = new Parser();

// ---- ENV ----
const PORT         = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;              // 必填：Telegram Bot Token
const CHAT_ID      = process.env.CHAT_ID;                   // 你的私人視窗或推播預設對象
const CRON_KEY     = process.env.CRON_KEY || "";            // /cron/*、/broadcast、/pub、(POST /lists) 驗證
const TZ           = process.env.TZ || "Asia/Taipei";
const PARSE_MODE   = process.env.PARSE_MODE || "Markdown";
const SYMBOLS_PATH = process.env.SYMBOLS_PATH || "./symbols.json"; // 全市場別名（可選）
const LISTS_PATH   = process.env.LISTS_PATH || "./lists.json";      // 追蹤清單持久化（JSON 檔）
// 主人與群組
const OWNER_ID       = Number(process.env.OWNER_ID || 8418229161);  // 你的 TG user id
const GROUP_CHAT_ID  = process.env.GROUP_CHAT_ID || "-4906365799";  // 群組 chat_id（負號開頭）

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

// ====== 模板讀取 ======
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

// ====== 金鑰驗證（cron/broadcast/pub/(POST /lists) 用） ======
function verifyKey(req,res){
  const key = req.headers["x-webhook-key"] || req.query.key || "";
  if (!CRON_KEY) return true;
  if (key !== CRON_KEY){ res.status(401).json({ok:false,error:"bad key"}); return false; }
  return true;
}

// 健康檢查
app.get(["/","/health"],(_,res)=>res.send("ok"));

// ====== 手動推播（保留） ======
app.post("/broadcast", async (req,res)=>{
  if(!verifyKey(req,res))return;
  const { text, chat_id, mode } = req.body||{};
  if(!text) return res.status(400).json({ ok:false, error:"text required" });
  try{ res.json({ ok:true, result: await sendTG(text, chat_id, mode) }); }
  catch(e){ console.error("broadcast error:",e?.response?.data||e.message); res.status(500).json({ ok:false, error:e?.response?.data||e.message }); }
});

// ====== 一鍵發布（POST /pub） ======
// body: { text: "...", target: "group" | "me", mode?: "Markdown" | null }
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

// ====== 你原本四個排程的組稿（保留） ======
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

// ====== 追蹤清單（預設 + 持久化） ======
let TRACK_SELF_DEFAULT = ["佳能","敬鵬","臻鼎-KY","新纖","力新","富喬","錦明"];
let TRACK_MOM_DEFAULT  = ["台燿","順達","帆宣","漢科","毅嘉"];

let TRACK_SELF = [...TRACK_SELF_DEFAULT];
let TRACK_MOM  = [...TRACK_MOM_DEFAULT];

async function loadLists(){
  try{
    const raw = await fs.readFile(LISTS_PATH,"utf8");
    const j = JSON.parse(raw||"{}");
    if (Array.isArray(j.self)) TRACK_SELF = [...new Set(j.self.filter(Boolean))];
    if (Array.isArray(j.mom))  TRACK_MOM  = [...new Set(j.mom.filter(Boolean))];
  }catch{ /* 初次沒有檔案就用預設 */ }
}
async function saveLists(){
  const j = { self: TRACK_SELF, mom: TRACK_MOM, savedAt: nowStr() };
  await fs.writeFile(LISTS_PATH, JSON.stringify(j,null,2));
}
async function ensureLists(){
  if (!TRACK_SELF || !TRACK_MOM) { TRACK_SELF=[...TRACK_SELF_DEFAULT]; TRACK_MOM=[...TRACK_MOM_DEFAULT]; }
}

// 啟動時嘗試載入清單
loadLists().catch(()=>{});

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

async function stockLine(nameOrCode){
  const hit = await resolveSymbol(nameOrCode);
  if (!hit) return `• ${nameOrCode}｜VWAP：—｜關鍵價：—｜操作/風控：—\n  四價：開— 高— 低— 收—`;
  const r = await fetchTWQuote(hit.code);
  const k = `• ${hit.code} ${hit.name || nameOrCode}｜VWAP：—｜關鍵價：—｜操作/風控：—`;
  if (!r.ok) return `${k}\n  四價：開— 高— 低— 收—`;
  return `${k}\n  四價：開${r.open} 高${r.high} 低${r.low} 收${r.close}`;
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
    if (!isTradingWeekday()) return res.json({ ok:true, skipped:"weekend" });
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
    if (!isTradingWeekday()) return res.json({ ok:true, skipped:"weekend" });
    const text = await composeMorningPhase2();
    const previewTarget = CHAT_ID || GROUP_CHAT_ID;      // 先發你個人（沒有就發群）
    const r = await sendTG(text, previewTarget, "Markdown");
    res.json({ ok:true, result:r, target: previewTarget });
  }catch(e){
    console.error("/cron/morning2 error:", e?.response?.data||e.message);
    res.status(500).json({ ok:false, error:e?.response?.data||e.message });
  }
});

// 相容端點：/cron/morning（一次觸發兩段）——給舊的 GitHub Actions 用
app.post("/cron/morning", async (req,res)=>{
  if(!verifyKey(req,res))return;
  try{
    if (!isTradingWeekday()) return res.json({ ok:true, skipped:"weekend" });
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

// ====== /lists：提供給 GPTs 讀（GET）／（可選）寫（POST, 需 key） ======
app.get("/lists", async (req,res)=>{
  try{
    await ensureLists();
    res.json({ ok:true, self: TRACK_SELF, mom: TRACK_MOM, updatedAt: nowStr() });
  }catch(e){
    res.status(500).json({ ok:false, error:e?.message||"lists error" });
  }
});

app.post("/lists", async (req,res)=>{
  if(!verifyKey(req,res))return;
  try{
    const { self, mom } = req.body || {};
    if (Array.isArray(self)) TRACK_SELF = [...new Set(self.filter(Boolean))];
    if (Array.isArray(mom))  TRACK_MOM  = [...new Set(mom.filter(Boolean))];
    await saveLists().catch(()=>{});
    res.json({ ok:true, self: TRACK_SELF, mom: TRACK_MOM, savedAt: nowStr() });
  }catch(e){
    res.status(500).json({ ok:false, error:e?.message||"lists write error" });
  }
});

// ====== Telegram /webhook：/menu + 查價（直覺/口語） + 發布到群（口令） + 清單維護 ======
app.post("/webhook", async (req,res)=>{
  res.sendStatus(200);
  try{
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

    // ==== 清單維護口令 ====
    // 顯示清單
    if (/^清單($|\s)/.test(text) || text === "清單" || text === "/清單"){
      await ensureLists();
      const s =
`📋 追蹤清單（${todayDateStr()}）
我：${TRACK_SELF.join("、") || "—"}
媽：${TRACK_MOM.join("、") || "—"}

用法：清單加 2402；清單減 2402；清單媽加 台燿；清單媽減 順達`;
      await sendTG(s, chatId, null);
      return;
    }
    if (/^清單我\b/.test(text)){
      await ensureLists();
      await sendTG(`我清單：${TRACK_SELF.join("、") || "—"}`, chatId, null);
      return;
    }
    if (/^清單媽\b/.test(text)){
      await ensureLists();
      await sendTG(`媽媽清單：${TRACK_MOM.join("、") || "—"}`, chatId, null);
      return;
    }
    // 加/減（我）
    let m;
    if ((m = text.match(/^清單加\s+(.+)/))){
      const items = m[1].split(/[ ,，、\s]+/).map(s=>s.trim()).filter(Boolean);
      for (const it of items){
        const hit = await resolveSymbol(it);
        const disp = hit ? (hit.name || hit.code) : it;
        if (!TRACK_SELF.includes(disp)) TRACK_SELF.push(disp);
      }
      await saveLists().catch(()=>{});
      await sendTG(`✅ 已加入（我）：${items.join("、")}\n目前：${TRACK_SELF.join("、")}`, chatId, null);
      return;
    }
    if ((m = text.match(/^清單減\s+(.+)/))){
      const items = m[1].split(/[ ,，、\s]+/).map(s=>s.trim()).filter(Boolean);
      TRACK_SELF = TRACK_SELF.filter(x => !items.includes(x));
      await saveLists().catch(()=>{});
      await sendTG(`🗑️ 已移除（我）：${items.join("、")}\n目前：${TRACK_SELF.join("、") || "—"}`, chatId, null);
      return;
    }
    // 加/減（媽）
    if ((m = text.match(/^清單媽加\s+(.+)/))){
      const items = m[1].split(/[ ,，、\s]+/).map(s=>s.trim()).filter(Boolean);
      for (const it of items){
        const hit = await resolveSymbol(it);
        const disp = hit ? (hit.name || hit.code) : it;
        if (!TRACK_MOM.includes(disp)) TRACK_MOM.push(disp);
      }
      await saveLists().catch(()=>{});
      await sendTG(`✅ 已加入（媽媽）：${items.join("、")}\n目前：${TRACK_MOM.join("、")}`, chatId, null);
      return;
    }
    if ((m = text.match(/^清單媽減\s+(.+)/))){
      const items = m[1].split(/[ ,，、\s]+/).map(s=>s.trim()).filter(Boolean);
      TRACK_MOM = TRACK_MOM.filter(x => !items.includes(x));
      await saveLists().catch(()=>{});
      await sendTG(`🗑️ 已移除（媽媽）：${items.join("、")}\n目前：${TRACK_MOM.join("、") || "—"}`, chatId, null);
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
        "🕖 07:40：/cron/morning1（自動發群）／/cron/morning2（先發給我看）",
        "🧩 舊相容：/cron/morning（兩段都跑）",
        "",
        "📋 清單維護：",
        "• 清單、清單我、清單媽",
        "• 清單加 2402｜清單減 2402",
        "• 清單媽加 台燿｜清單媽減 順達",
        "",
        "📢 群發口令（限本人）：`發布：<要發到群的全文>`",
      ].join("\n");
      return sendTG(s, chatId, "Markdown");
    }

    // === 查價偵測（指令式 + 直覺式 + 口語式） ===
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

    // 其它文字就回覆已收到（避免沉默）
    if (text) await sendTG(`收到：「${text}」`, chatId, null);
  }catch(e){
    console.error("/webhook error:", e?.response?.data||e.message);
  }
});

app.listen(PORT, ()=>console.log(`orbit07-webhook up on :${PORT}`));
