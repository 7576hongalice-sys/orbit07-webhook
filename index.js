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
async function sendTG(text, chatId,
