// link_listener.js — 專門處理「轉貼連結 / caption / channel_post」
function pickTGMessage(update) {
  return (
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post ||
    null
  );
}

function extractTextAndUrls(msg = {}) {
  const base = (msg.text ?? msg.caption ?? "").trim();
  const entities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];
  const urls = [];

  for (const e of entities) {
    if (e.type === "url" && typeof base === "string") {
      urls.push(base.slice(e.offset, e.offset + e.length));
    } else if (e.type === "text_link" && e.url) {
      urls.push(e.url);
    }
  }
  const inline = (base.match(/https?:\/\/\S+/g) || []);
  const uniq = [...new Set([...urls, ...inline])];
  return { text: base, urls: uniq };
}

/**
 * handleLinkUpdate(update, sendTG, handlers)
 * @param {Object} update  Telegram webhook 的原始 JSON
 * @param {Function} sendTG  (chatId, text) => Promise<void>  你原本發訊函式
 * @param {Object} handlers  { clipSummary?: (chatId, link)=>Promise }
 * @returns {Promise<boolean>} 是否已處理（true=已處理；false=未處理）
 */
async function handleLinkUpdate(update, sendTG, handlers = {}) {
  const msg = pickTGMessage(update);
  if (!msg) return false;

  const { text, urls } = extractTextAndUrls(msg);
  const chatId = (msg.chat && msg.chat.id) || null;

  // 沒有文字也沒有連結就不處理
  if (!text && urls.length === 0) return false;

  // 指令讓給原本程式去處理（這裡只管連結）
  const lower = (text || "").toLowerCase();
  if (/^(查價|\/price|清單|\/list)\b/.test(lower)) return false;

  // 只要偵測到連結就觸發（你也可改成白名單）
  const link = urls[0] || "";
  if (link && chatId) {
    if (typeof handlers.clipSummary === "function") {
      await handlers.clipSummary(chatId, link);
    } else {
      await sendTG(chatId, `🔗 偵測到連結，準備摘要：\n${link}`);
    }
    return true; // 表示本模組已處理完
  }

  return false;
}

module.exports = { handleLinkUpdate };
