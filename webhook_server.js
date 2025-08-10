const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

// ---- Day.js 固定台北時區 ----
dayjsBase.extend(utc);
dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

// ---- 環境變數（可覆蓋）----
const TOKEN   = process.env.BOT_TOKEN || "8279.....";
const CHAT_ID = process.env.CHAT_ID   || "8418.....";
const TG_API  = `https://api.telegram.org/bot${TOKEN}`;

const app = express();
app.use(express.json());

// ✅ 在這裡加上 link_listener
const { handleLinkUpdate } = require("./link_listener");

// ============ 小工具 ============
function replyKeyboard() { /* ... */ }
async function tgSend(chatId, text, extra = {}) { /* ... */ }
const send = (chatId, text) => tgSend(chatId, text, replyKeyboard());
// ... 省略 ALIAS、normalizeSymbol、fetchDailyClose 等 ...

// ============ 指令處理 ============
async function handleCommand(chatId, text) { /* ... 原本你的內容 ... */ }

// ============ HTTP 路由 ============
app.get("/", (req, res) => { /* ... */ });
app.get("/health", (req, res) => { /* ... */ });
app.get("/ping", async (req, res) => { /* ... */ });

// Telegram webhook
app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  const run = async () => {
    try {
      const update = req.body;

      // ✅ 一進來先讓 link_listener 處理轉貼連結
      const handled = await handleLinkUpdate(update, send, {
        clipSummary: async (chatId, link) => {
          // 這裡可以換成你真正的 clip 摘要流程
          return send(chatId, `🔗 偵測到連結，準備摘要：\n${link}`);
        }
      });
      if (handled) return; // 已處理就不往下跑

      // 🔽 原本的流程保留
      const msg =
        update.message ||
        update.edited_message ||
        update.channel_post ||
        update.edited_channel_post;
      if (!msg) return;
      const chatId = String(msg.chat?.id || "");
      if (!chatId) return;

      const text = (msg.text || msg.caption || "").trim();
      if (!text) return send(chatId, "（非文字訊息）", replyKeyboard());

      if (text.startsWith("/")) {
        await handleCommand(chatId, text);
      } else {
        await handleCommand(chatId, text);
      }
    } catch (e) {
      console.error("webhook handler error:", e);
    }
  };
  if (typeof queueMicrotask === "function") queueMicrotask(run);
  else setImmediate(run);
});

// ============ 定時推播 ============
cron.schedule("40 7 * * 1-5", async () => { /* ... */ });
