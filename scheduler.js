import cron from "node-cron";
import dayjs from "dayjs";
import { sendMessage } from "./telegram.js";

function isWeekday(d = new Date()) {
  const day = dayjs(d).day(); // 0 Sun .. 6 Sat
  return day >= 1 && day <= 5;
}

export function initSchedulers({ tz, chatIdsProvider }) {
  const jobs = [];

  function schedule(name, cronExp, fn) {
    const job = cron.schedule(cronExp, fn, { timezone: tz });
    jobs.push({ name, job });
    console.log(`[cron] scheduled ${name} @ ${cronExp} (${tz})`);
  }

  const sendAll = async (text) => {
    const ids = await chatIdsProvider();
    if (!ids.length) {
      console.warn("[cron] No allowed chat ids yet; skip push.");
      return;
    }
    await Promise.allSettled(ids.map(id => sendMessage(id, text)));
  };

  // 07:15 盤前導航（工作日）
  schedule("pre-open", "15 7 * * 1-5", async () => {
    if (!isWeekday()) return;
    await sendAll("📆 <b>盤前重點 × 操作導航</b>\n（此為範本：待接資料源）");
  });

  // 09:10 投顧摘要（工作日）
  schedule("analyst-brief", "10 9 * * 1-5", async () => {
    if (!isWeekday()) return;
    await sendAll("🧭 <b>投顧簡報摘要</b>\n（此為範本：待接 OCR/TG/FB 來源）");
  });

  // 12:30 午盤小結（工作日）
  schedule("midday", "30 12 * * 1-5", async () => {
    if (!isWeekday()) return;
    await sendAll("🍱 <b>午盤小結</b>\n（此為範本：待接即時行情）");
  });

  // 13:40 收盤報告（工作日）
  schedule("close", "40 13 * * 1-5", async () => {
    if (!isWeekday()) return;
    await sendAll("🔚 <b>收盤報告</b>\n（此為範本：待接三大法人與持股追蹤）");
  });

  // 16:00 投資日誌提醒（每日）
  schedule("journal", "0 16 * * *", async () => {
    await sendAll("📝 <b>投資日誌提醒</b>\n今天的進出與感受，寫一行就好。");
  });

  return () => jobs.forEach(({ job }) => job.stop());
}
