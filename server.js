import express from "express";
import { config } from "./config.js";
import { setWebhook, getWebhookInfo, deleteWebhook, getMe, sendMessage } from "./telegram.js";
import { getState, setLastUpdateId, addAllowedChat, getAllowedChatIds } from "./db.js";
import { initSchedulers } from "./scheduler.js";

const app = express();
app.use(express.json());

// Health
app.get("/healthz", async (_, res) => {
  const info = await getWebhookInfo().catch(() => null);
  res.json({ ok: true, webhook: info, now: Date.now() });
});

// Install webhook helper (optional)
// curl -s "$APP_BASE_URL/install-webhook?key=YOUR_ADMIN_ID"
app.get("/install-webhook", async (req, res) => {
  if (String(config.adminId) !== String(req.query.key)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  const url = `${config.baseUrl}/webhook/${config.secret}`;
  const r = await setWebhook(url);
  res.json({ ok: true, result: r, url });
});

// Webhook
app.post(`/webhook/${config.secret}`, async (req, res) => {
  const update = req.body;
  if (!update) return res.sendStatus(200);
  const state = await getState();
  if (update.update_id && update.update_id <= (state.last_update_id || 0)) {
    // duplicate delivery
    return res.sendStatus(200);
  }
  await setLastUpdateId(update.update_id || 0);

  try {
    if (update.message) await handleMessage(update.message);
    if (update.my_chat_member) await handleMyChatMember(update.my_chat_member);
  } catch (err) {
    console.error("[webhook] handle error:", err);
  }
  res.sendStatus(200);
});

async function handleMyChatMember(m) {
  const chat = m.chat;
  if (m.new_chat_member && ["member", "administrator"].includes(m.new_chat_member.status)) {
    await addAllowedChat(chat);
    await sendMessage(chat.id, "✅ 機器人已加入，輸入 /start 完成註冊。");
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  if (text.startsWith("/start")) {
    await addAllowedChat(msg.chat);
    await sendMessage(chatId, "👋 歡迎～已完成註冊。\n輸入 /id 取得本聊天室 ID。");
    return;
  }
  if (text.startsWith("/id")) {
    await sendMessage(chatId, `🆔 chat_id = <code>${chatId}</code>`);
    return;
  }
  if (text.startsWith("/broadcast")) {
    if (String(msg.from.id) !== String(config.adminId)) {
      await sendMessage(chatId, "🚫 只有管理員可以使用 /broadcast");
      return;
    }
    const payload = text.replace("/broadcast", "").trim();
    const ids = await getAllowedChatIds(config.allowedChats);
    await Promise.allSettled(ids.map(id => sendMessage(id, `📣 <b>廣播</b>\n${payload}`)));
    await sendMessage(chatId, `✅ 已廣播給 ${ids.length} 個聊天室。`);
    return;
  }
  // default: echo
  await sendMessage(chatId, `你說：「${text.slice(0, 200)}」`);
}

// Boot
const stopCron = initSchedulers({
  tz: config.tz,
  chatIdsProvider: () => getAllowedChatIds(config.allowedChats)
});

app.listen(config.port, async () => {
  const me = await getMe().catch(() => null);
  console.log(`Server on :${config.port} TZ=${config.tz}`);
  console.log("Bot =", me);
  console.log("Set webhook via:", `${config.baseUrl}/install-webhook?key=${config.adminId}`);
});

process.on("SIGTERM", () => {
  stopCron?.();
  process.exit(0);
});
