import dotenv from "dotenv";
dotenv.config();

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] Missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

export const config = {
  token: required("BOT_TOKEN"),
  baseUrl: required("APP_BASE_URL").replace(/\/$/, ""),
  secret: required("WEBHOOK_SECRET"),
  adminId: Number(required("ADMIN_ID")),
  tz: process.env.TZ || "Asia/Taipei",
  port: Number(process.env.PORT || 3000),
  allowedChats: (process.env.ALLOWED_CHAT_IDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number)
};
