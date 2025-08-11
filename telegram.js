import axios from "axios";
import { config } from "./config.js";

const api = axios.create({
  baseURL: `https://api.telegram.org/bot${config.token}/`,
  timeout: 10000
});

async function call(method, data) {
  try {
    const res = await api.post(method, data);
    if (!res.data.ok) {
      throw new Error(`${method} failed: ${JSON.stringify(res.data)}`);
    }
    return res.data.result;
  } catch (err) {
    console.error("[tg.call] error:", err.message);
    throw err;
  }
}

export async function sendMessage(chat_id, text, extra = {}) {
  return call("sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
  });
}

export async function setWebhook(url) {
  return call("setWebhook", {
    url,
    allowed_updates: [
      "message",
      "edited_message",
      "callback_query",
      "my_chat_member",
      "chat_member",
      "channel_post",
      "edited_channel_post"
    ],
    drop_pending_updates: true
  });
}

export async function deleteWebhook() {
  return call("deleteWebhook", { drop_pending_updates: true });
}

export async function getWebhookInfo() {
  return call("getWebhookInfo", {});
}

export async function answerCallbackQuery(id, extra = {}) {
  return call("answerCallbackQuery", { callback_query_id: id, ...extra });
}

export async function getMe() {
  return call("getMe", {});
}
