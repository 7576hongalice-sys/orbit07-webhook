// Node 18+ (原生 fetch)
// -------------------------------------
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
const TOKEN   = process.env.BOT_TOKEN || "8279562243:AAEyhzGPAy7FeK-TvJQAbwhAPVLHXG_z2gY";
const CHAT_ID = process.env.CHAT_ID   || "8418229161";
const TG_API  = `https://api.telegram.org/bot${TOKEN}`;

const app = express();
app.use(express.json());

// ============ 小工具 ============
// Reply Keyboard（常駐快捷鍵 A 模式）
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

async function tgSend(chatId, text, extra = {}) {
  const url = `${TG_API}/sendMessage`;
  const body = { chat_id: chatId, text, ...extra };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let j;
  try { j = await res.json(); } catch { j = { ok:false, status:res.status }; }
  if (!j.ok) {
    console.error("send() exception:", j);
    throw new Error("sendMessage failed");
  }
  return j;
}
const send = (chatId, text) => tgSend(chatId, text, replyKeyboard());

// 代號別名（你目前用到的先內建；之後可再補）
const ALIAS = {
  // 你的持股
  "2618": "長榮航", "長榮航":"2618",
  "5905": "南仁湖", "南仁湖":"5905",
  "5202": "力新",   "力新":"5202",
  "2884": "玉山金", "玉山金":"2884",
  "00687B": "國泰20年美債", "國泰20年美債":"00687B",
  "00937B": "群益投資級債", "群益投資級債":"00937B",
  // 追蹤
  "2355": "敬鵬", "敬鵬":"2355",
  "2374": "佳能", "佳能":"2374",
  "1815": "富喬", "富喬":"1815",
  "2438": "翔耀", "翔耀":"2438",
  "2027": "大成鋼", "大成鋼":"2027",
  // 常見
  "2330": "台積電", "台積電":"2330",
  "2317": "鴻海",   "鴻海":"2317",
  "3715": "定穎投控",   "定穎投控":"3715",
  "2382": "廣達",   "廣達":"2382",
  "5314": "世紀",   "世紀":"5314",
};

// 正規化：輸入名稱或代號皆可，回傳 {code,name}
function normalizeSymbol(inputRaw) {
  const s = String(inputRaw).trim().toUpperCase();
  // 代號
  if (/^\d{4,5}[A-Z]*$/.test(s)) {
    const name = ALIAS[s] || null;
    return { code: s, name };
  }
  // 名稱
  const code = ALIAS[s] || null;
  if (code) return { code, name: s };
  return null;
}

// 抓日收（TWSE / TPEX 簡易容錯版）
async function fetchDailyClose(code) {
  // 先試 TWSE
  const ts = Date.now();
  const urls = [
    // TWSE 當日個股(簡表) JSON
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${code}.tw&json=1&_=${ts}`,
    // 若為櫃買（tpex）
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=otc_${code}.tw&json=1&_=${ts}`
  ];

  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { "cache-control": "no-cache" } });
      const j = await r.json();
      if (j && j.msgArray && j.msgArray.length) {
        const it = j.msgArray[0];
        // it.z 收盤、it.o 開、it.h 高、it.l 低、it.n 名稱
        if (it.z && it.z !== "-") {
          return {
            ok: true,
            name: it.n || "",
            open: it.o || "-",
            high: it.h || "-",
            low:  it.l || "-",
            close: it.z,
            date: it.d || dayjs().format("YYYY/MM/DD"),
            market: url.includes("tse_") ? "TWSE" : "TPEX"
          };
        }
      }
    } catch (e) {
      // 繼續嘗試下一個
    }
  }
  return { ok:false };
}

// ============ 狀態（簡易記憶） ============
const state = {
  mode: "auto",            // auto | work
  lastJournalDoneDate: null,   // YYYY-MM-DD
  remind: {                 // 兩個提醒預設啟用，但不佔按鈕
    bath: true,   // 21:30
    sleep: true   // 23:00
  },
  // 追蹤清單 & 持股（成本）
  watch: new Set(["2355","2374","1815","2438","2027","2382","5314"]),
  holds: {
    // 代號: 成本（字串）
    "2618": "42.5",
    "5905": "15",
    "5202": "26.5",
    "2884": "30.5",
    "00687B": "31.5",
    "00937B": "16",
  }
};

// ============ 指令處理 ============
async function handleCommand(chatId, text) {
  const t = text.trim();

  // 選單說明
  if (t === "/menu" || t === "menu") {
    return send(chatId,
`可用指令：
/上班  只推重要訊息（08:00-17:00）
/自動  平/假日自動判斷
/狀態  檢視目前設定
/股價  代號或名稱（例：/股價 2374 或 /股價 佳能）
/持股設定 代號 成本（例：/持股設定 2618 成本 35.5）
/追蹤新增 代號（例：/追蹤新增 2374）
/追蹤移除 代號（例：/追蹤移除 2374）
/洗澡提醒開 | /洗澡提醒關
/睡覺提醒開 | /睡覺提醒關
（也可直接點下方功能列，或輸入「查佳能」「股價 2330」）`);
  }

  // 模式切換
  if (t === "/上班" || t === "上班") {
    state.mode = "work";
    return send(chatId, "已切換：上班模式 ✅");
  }
  if (t === "/自動" || t === "自動") {
    state.mode = "auto";
    return send(chatId, "已切換：自動模式 ✅");
  }

  // 提醒開關（不佔按鈕）
  if (t === "/洗澡提醒開") { state.remind.bath = true;  return send(chatId,"21:30 洗澡提醒已啟用 ✅"); }
  if (t === "/洗澡提醒關") { state.remind.bath = false; return send(chatId,"21:30 洗澡提醒已關閉 ✅"); }
  if (t === "/睡覺提醒開") { state.remind.sleep = true;  return send(chatId,"23:00 睡覺提醒已啟用 ✅"); }
  if (t === "/睡覺提醒關") { state.remind.sleep = false; return send(chatId,"23:00 睡覺提醒已關閉 ✅"); }

  // 狀態
  if (t === "/狀態" || t === "狀態") {
    return send(chatId,
`台北時間：${dayjs().format("YYYY-MM-DD HH:mm")}
上班：平日 08:00–17:00
盤前導航：07:40（平日）
開盤補充：08:55（平日）
日誌提醒：平日16:30；週末21:00；隔日07:30補查
模式：${state.mode}
洗澡提醒：${state.remind.bath ? "開" : "關"}（21:30）
睡覺提醒：${state.remind.sleep ? "開" : "關"}（23:00）`);
  }

  // clip 佔位
  if (t === "clip 摘要 今日" || t === "/clip摘要今天" || t === "/clip摘要 今日") {
    return send(chatId, "Clip 功能位保留（之後接入）。");
  }
  if (t === "clip 清單" || t === "/clip清單") {
    return send(chatId, "Clip 功能位保留（之後接入）。");
  }

  // 清單（顯示追蹤與持股）
  if (t === "清單" || t === "/清單") {
    let s = "【追蹤清單】\n";
    if (state.watch.size === 0) s += "（空）\n";
    else {
      let idx = 1;
      for (const code of state.watch) {
        s += `${idx++}) ${code} ${ALIAS[code] || ""}\n`;
      }
    }
    s += "\n【持股清單（成本）】\n";
    const keys = Object.keys(state.holds);
    if (keys.length === 0) s += "（空）\n";
    else {
      let idx = 1;
      for (const code of keys) {
        s += `${idx++}) ${code} ${ALIAS[code] || ""}  成本 ${state.holds[code]}\n`;
      }
    }
    s += `\n（清單）功能待補：會顯示你的追蹤與持股清單。`;
    return send(chatId, s);
  }

  // 追蹤新增/移除
  if (/^\/追蹤新增\s+/.test(t)) {
    const arg = t.replace(/^\/追蹤新增\s+/,"").trim();
    const n = normalizeSymbol(arg);
    if (!n) return send(chatId, "格式：/追蹤新增 代號 或 名稱");
    state.watch.add(n.code);
    return send(chatId, `已加入追蹤：${n.code} ${n.name || ALIAS[n.code] || ""}`);
  }
  if (/^\/追蹤移除\s+/.test(t) || /^移除$/.test(t)) {
    const arg = t.replace(/^\/追蹤移除\s+/,"").trim();
    const n = normalizeSymbol(arg);
    if (!n) return send(chatId, "格式：/追蹤移除 代號 或 名稱");
    state.watch.delete(n.code);
    return send(chatId, `已自追蹤移除：${n.code} ${n.name || ALIAS[n.code] || ""}`);
  }

  // 持股設定（張數可省略）
  if (/^\/持股設定\s+/.test(t)) {
    // /持股設定 2618 成本 35.5（張數 n 可省略）
    const m = t.match(/^\/持股設定\s+(\S+)\s+成本\s+(\S+)/);
    if (!m) return send(chatId, "格式：/持股設定 代號 成本 35.5");
    const n = normalizeSymbol(m[1]);
    if (!n) return send(chatId, "代號/名稱無法辨識。");
    state.holds[n.code] = String(m[2]);
    return send(chatId, `已設定持股 ${n.code} ${ALIAS[n.code] || ""} 成本 ${state.holds[n.code]} ✅`);
  }

  // 股價（/股價 xxx、股價 xxx、查價 xxx、查 xxx、查台積電…）
  let q = null;
  // 1) 顯式命令
  {
    let m = t.match(/^\/?(股價|查價|查)\s+(.+)$/);
    if (m) q = m[2].trim();
  }
  // 2) 單獨觸發詞（查價）-> 請他接代號或名稱
  if (!q && (t === "查價" || t === "/股價")) {
    return send(chatId, "請輸入：股價 代號 或 名稱（例：股價 2330、查 佳能）");
  }
  // 3) 「查佳能」直接抽出名稱
  if (!q) {
    let m2 = t.match(/^(查|股價)\s*(.*)$/);
    if (m2 && m2[2]) q = m2[2].trim();
  }
  if (q) {
    const n = normalizeSymbol(q);
    if (!n) return send(chatId, "找不到對應的代號/名稱。");
    try {
      const r = await fetchDailyClose(n.code);
      if (!r.ok) return send(chatId, `【${n.code}｜${ALIAS[n.code]||n.name||"TWSE"}】暫無取得到即時/日收資料，稍後再試。`);
      const line =
`【${n.code}｜${r.market}】 ${r.date} 收：${r.close}
(開:${r.open} 高:${r.high} 低:${r.low})`;
      return send(chatId, line);
    } catch (e) {
      console.error("price error:", e);
      return send(chatId, "查價發生錯誤，稍後再試。");
    }
  }

  // 預設：一般訊息
  return send(chatId, `收到：「${t}」`);
}

// ============ HTTP 路由 ============
app.get("/", (req, res) => {
  res.send({ ok:true, service:"orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") });
});
app.get("/health", (req, res) => {
  res.json({ ok:true, service:"orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") });
});
app.get("/ping", async (req, res) => {
  try {
    const j = await tgSend(CHAT_ID, req.query.text || "HelloFromWebhook", replyKeyboard());
    res.json({ ok:true, result:j.result || j });
  } catch (e) {
    res.status(200).json({ ok:false, msg:"ping failed" });
  }
});

// Telegram webhook（回 200、非同步處理）
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  const run = async () => {
    try {
      const update = req.body;
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

      // 所有訊息都帶上固定功能列
      if (text.startsWith("/")) {
        await handleCommand(chatId, text);
      } else {
        // 允許自然語句：查價/股價/查xx
        await handleCommand(chatId, text);
      }
    } catch (e) {
      console.error("webhook handler error:", e);
    }
  };
  if (typeof queueMicrotask === "function") queueMicrotask(run);
  else setImmediate(run);
});

// ============ 定時推播（Asia/Taipei）===========
// 07:40 盤前導航（平日）
cron.schedule("40 7 * * 1-5", async () => {
  try {
    const now = dayjs();
    // 上班模式 or 自動且平日
    if (state.mode === "work" || (state.mode === "auto" && [1,2,3,4,5].includes(now.day()))) {
      await send(CHAT_ID,
`【盤前導航｜07:40】
• 大盤五重點（國際盤/新聞/技術/籌碼/氛圍）
• 三大法人籌碼（前日）
• 投顧早報（已出稿者）
• 今日策略與觀察股
（模板，之後接資料）`);
    }
  } catch (e) { console.error("07:40 push error", e); }
}, { timezone:"Asia/Taipei" });

// 08:55 開盤補充（平日）
cron.schedule("55 8 * * 1-5", async () => {
  try {
    const now = dayjs();
    if (state.mode === "work" || (state.mode === "auto" && [1,2,3,4,5].includes(now.day()))) {
      await send(CHAT_ID,
`【開盤補充｜08:55】
• 集合競價/委託量
• 早盤異常股
（模板）`);
    }
  } catch (e) { console.error("08:55 push error", e); }
}, { timezone:"Asia/Taipei" });

// 16:30 平日收盤後日誌提醒（時間已改為 16:30）
cron.schedule("30 16 * * 1-5", async () => {
  try {
    const now = dayjs();
    if (state.mode === "work" || (state.mode === "auto" && [1,2,3,4,5].includes(now.day()))) {
      await send(CHAT_ID, "【提醒】收盤囉～要不要記今天的戀股日誌？（回覆 /日誌完成）");
    }
  } catch (e) { console.error("16:30 reminder error", e); }
}, { timezone:"Asia/Taipei" });

// 21:00 週末日誌提醒
cron.schedule("0 21 * * 6,0", async () => {
  try {
    await send(CHAT_ID, "【提醒】今晚要不要補本週的戀股日誌與策略？（/日誌完成）");
  } catch (e) { console.error("21:00 weekend reminder error", e); }
}, { timezone:"Asia/Taipei" });

// 07:30 隔日補檢查
cron.schedule("30 7 * * *", async () => {
  try {
    const yesterday = dayjs().subtract(1,"day").format("YYYY-MM-DD");
    if (state.lastJournalDoneDate === yesterday) return;
    await send(CHAT_ID, `【補提醒｜07:30】你昨天（${yesterday}）的戀股日誌還沒完成喔～（/日誌完成）`);
  } catch (e) { console.error("07:30 backfill error", e); }
}, { timezone:"Asia/Taipei" });

// 21:30 洗澡提醒（預設啟用、不佔按鈕）
cron.schedule("30 21 * * *", async () => {
  try { if (state.remind.bath) await send(CHAT_ID, "21:30 到啦～去洗香香🛁"); }
  catch (e) { console.error("21:30 bath remind error", e); }
}, { timezone:"Asia/Taipei" });

// 23:00 睡覺提醒（預設啟用、不佔按鈕）
cron.schedule("0 23 * * *", async () => {
  try { if (state.remind.sleep) await send(CHAT_ID, "23:00～準備上床睡覺 😴"); }
  catch (e) { console.error("23:00 sleep remind error", e); }
}, { timezone:"Asia/Taipei" });

// 日誌完成
app.post("/done", (req, res) => res.sendStatus(204));
async function markJournalDone() {
  state.lastJournalDoneDate = dayjs().format("YYYY-MM-DD");
}
app.post("/webhook-done", async (req,res)=>{ await markJournalDone(); res.sendStatus(204); });

// ---- 啟動 ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ webhook server listening on ${PORT}`));
