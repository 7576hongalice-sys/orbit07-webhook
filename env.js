// env.js — 強制讀取必要環境變數
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

module.exports = {
  BOT_TOKEN: requireEnv("BOT_TOKEN"), // 你的 Telegram Bot Token
  CHAT_ID:   requireEnv("CHAT_ID"),   // 你的 Chat ID：8418229161
  BASE_URL:  requireEnv("BASE_URL"),  // 你的公開網址，如 https://orbit07-webhook.onrender.com
};
