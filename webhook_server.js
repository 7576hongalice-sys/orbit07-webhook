// webhook_server.js — ORBIT07 webhook (Render-ready)
// Node 18+ (global fetch)
// -------------------------------------------------
const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjsBase.extend(utc);
dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

// ---- Env ----
const TOKEN   = process.env.BOT_TOKEN || "YOUR_TG_BOT_TOKEN";
const CHAT_ID = process.env.CHAT_ID   || ""; // 可留空，/ping 會用
const TG_API  = `https://api.telegram.org/bot${TOKEN}`;

const app = express();
app.use(express.json());

// ---- Link listener (轉貼連結偵測) ----
const { handleLinkUpdate } = require("./link_listener");

// ---- UI：常駐快捷鍵 ----
function replyKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "查價" }, { text: "清單" }, { text: "clip 摘要 今日" }],
        [{ text: "狀態" }, { text: "上班" }, { text: "自動" }],
      ],
      resize_keyboard: true,
      is_persistent: true
    }
  };
}

// ---- Telegram 發訊 ----
async function tgSend(chatId, text, extra = {}) {
  const url = `${TG_API}/sendMessage`;
  const body = { chat_id: chatId, text, ...extra };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  let j; try { j = await r.json(); } catch { j = { ok:false, status:r.status }; }
  if (!j.ok) {
    console.error("sendMessage failed:", j);
    throw new Error("sendMessage failed");
  }
  return j;
}
const send = (chatId, text) => tgSend(chatId, text, replyKeyboard());

// ---- 代號別名 ----
const ALIAS = {
  "2618": "長榮航", "長榮航":"2618",
  "5905": "南仁湖", "南仁湖":"5905",
  "5202": "力新",   "力新":"5202",
  "2884": "玉山金", "玉山金":"2884",
  "00687B": "國泰20年美債", "國泰20年美債":"00687B",
  "00937B": "群益投資級債", "群益投資級債":"00937B",
  "2355": "敬鵬", "敬鵬":"2355",
  "2374": "佳能", "佳能":"2374",
  "1815": "富喬", "富喬":"1815",
  "2438": "翔耀", "翔耀":"2438",
  "2027": "大成鋼", "大成鋼":"2027",
  "2382": "廣達", "廣達":"2382",
  "5314": "世紀", "世紀":"5314",
  "2330": "台積電", "台積電":"2330",
  "2317": "鴻海",   "鴻海":"2317",
  "3715": "定穎投控", "定穎投控":"3715",
};

// ---- 正規化：輸入名稱或代號皆可 ----
function normalizeSymbol(inputRaw) {
  const s = String(inputRaw).trim().toUpperCase();
  if (/^\d{4,5}[A-Z]*$/.test(s)) {
    const name = ALIAS[s] || null;
    return { code: s, name };
  }
  const code = ALIAS[s] || null;
  if (code) return { code, name: s };
  return null;
}

// ---- 簡易日收/即時（TWSE 快速
