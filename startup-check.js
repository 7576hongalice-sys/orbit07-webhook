// startup-check.js — 啟動自檢（health、setWebhook、打招呼）
async function setWebhook(baseUrl, TG_API) {
  const url = `${TG_API}/setWebhook?url=${encodeURIComponent(baseUrl + "/webhook")}`;
  const r = await fetch(url);
  const j = await r.json().catch(()=> ({}));
  if (!j.ok) throw new Error("setWebhook failed: " + JSON.stringify(j));
}

async function pingSelf(baseUrl) {
  const r = await fetch(baseUrl + "/health");
  if (!r.ok) throw new Error("health failed: " + r.status);
}

async function hello(TG_API, chatId) {
  const r = await fetch(`${TG_API}/sendMessage`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ chat_id: chatId, text: "✅ Bot 上線囉（啟動自檢完成）" })
  });
  const j = await r.json().catch(()=> ({}));
  if (!j.ok) throw new Error("hello failed: " + JSON.stringify(j));
}

module.exports = { setWebhook, pingSelf, hello };
