// === index.js（支援 /cron/* 與 /broadcast，含「今日頭條」；Markdown + 失敗退回）===
const express = require("express");
const axios = require("axios");
const fs = require("fs/promises");
const path = require("path");

// 抓當天路透頭條（免費 RSS）
const Parser = require("rss-parser");
const parser = new Parser();

const PORT         = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID      = process.env.CHAT_ID;
const CRON_KEY     = process.env.CRON_KEY || ""; // /cron/* 與 /broadcast 驗證
const TZ           = process.env.TZ || "Asia/Taipei";
// ⬇️ 這行已改成 Markdown（原本是 "HTML"）
const PARSE_MODE   = process.env.PARSE_MODE || "Markdown";

if (!TG_BOT_TOKEN) console.warn("⚠️  TG_BOT_TOKEN 未設定，將無法推播");
if (!CHAT_ID)      console.warn("⚠️  CHAT_ID 未設定，/broadcast 需要 body.chat_id");

const app = express();
app.use(express.json());

function nowStr(){ return new Date().toLocaleString("zh-TW",{ timeZone: TZ }); }

async function readTemplate(name){
  const p = path.join(__dirname,"content",`${name}.txt`);
  try { const t = (await fs.readFile(p,"utf8")||"").trim(); return t||`(${name} 尚無內容)`; }
  catch { return `(${name} 模板讀取失敗或不存在)`; }
}

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

// ⬇️ 先用 Markdown；若 Telegram 因格式拒收，退回純文字再次嘗試
async function sendTG(text, chatId, mode){
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const base = { chat_id: chatId||CHAT_ID, text, disable_web_page_preview:true };
  try {
    const { data } = await axios.post(url, { ...base, parse_mode: mode||PARSE_MODE }, { timeout: 25000 });
    return data;
  } catch (e) {
    // 退回純文字（無 parse_mode）
    const { data } = await axios.post(url, base, { timeout: 25000 });
    return data;
  }
}

function verifyKey(req,res){
  const key = req.headers["x-webhook-key"] || req.query.key || "";
  if (!CRON_KEY) return true;
  if (key !== CRON_KEY){ res.status(401).json({ok:false,error:"bad key"}); return false; }
  return true;
}

app.get(["/","/health"],(_,res)=>res.send("ok"));

// 手動推播（給 GPT Action 或你自己）
app.post("/broadcast", async (req,res)=>{
  if(!verifyKey(req,res))return;
  const { text, chat_id, mode } = req.body||{};
  if(!text) return res.status(400).json({ ok:false, error:"text required" });
  try{ res.json({ ok:true, result: await sendTG(text, chat_id, mode) }); }
  catch(e){ console.error("broadcast error:",e?.response?.data||e.message); res.status(500).json({ ok:false, error:e?.response?.data||e.message }); }
});

// 四個排程端點：07:30 盤前、08:55 開盤、13:00 午盤、16:30 收盤
async function compose(mode){
  const header = {
    morning:"🧭 戀股主場｜盤前導航",
    open:"🚀 戀股主場｜開盤提醒",
    noon:"⏱️ 戀股主場｜午盤小結",
    close:"📊 戀股主場｜收盤小結"
  }[mode] || "📮 推播";

  const tpl = { morning:"preopen", open:"preopen", noon:"noon", close:"close" }[mode] || "preopen";

  const [body, shot] = await Promise.all([ readTemplate(tpl), fetchSnapshot() ]);

  // 組訊息 + 長度保險（避免超過 Telegram 4096 字）
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

// 簡單測試
app.post("/cron/ping", async (req,res)=>{
  if(!verifyKey(req,res))return;
  try{ await sendTG(`🔔 測試訊息\n${req.body?.msg||"pong"}\n${nowStr()}`); res.send("pong"); }
  catch(e){ console.error(e?.response?.data||e.message); res.status(500).send("tg error"); }
});

app.listen(PORT, ()=>console.log(`orbit07-webhook up on :${PORT}`));
