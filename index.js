// === index.js（精簡可用版；支援 /cron/* 與 /broadcast）===
const express = require("express");
const axios = require("axios");
const fs = require("fs/promises");
const path = require("path");

const PORT       = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID    = process.env.CHAT_ID;
const CRON_KEY   = process.env.CRON_KEY || "";         // /cron/* 與 /broadcast 驗證
const TZ         = process.env.TZ || "Asia/Taipei";
const PARSE_MODE = process.env.PARSE_MODE || "HTML";

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

async function sendTG(text, chatId, mode){
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: chatId||CHAT_ID, text, parse_mode: mode||PARSE_MODE, disable_web_page_preview:true };
  const { data } = await axios.post(url, payload, { timeout: 25000 });
  return data;
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
  const header = { morning:"🧭 戀股主場｜盤前導航", open:"🚀 戀股主場｜開盤提醒", noon:"⏱️ 戀股主場｜午盤小結", close:"📊 戀股主場｜收盤小結" }[mode] || "📮 推播";
  const tpl    = { morning:"preopen", open:"preopen", noon:"noon", close:"close" }[mode] || "preopen";
  const body = await readTemplate(tpl);
  return `${header}｜${nowStr()}

${body}

——
夜辰：記得喝水，紀律比行情重要。`;
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
  try{ await sendTG(`🔔 <b>測試訊息</b>\n${req.body?.msg||"pong"}\n${nowStr()}`); res.send("pong"); }
  catch(e){ console.error(e?.response?.data||e.message); res.status(500).send("tg error"); }
});

app.listen(PORT, ()=>console.log(`orbit07-webhook up on :${PORT}`));
