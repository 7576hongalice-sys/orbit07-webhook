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

// ---- 簡易日收/即時（TWSE 快速接口）----
async function fetchDailyClose(code) {
  const ts = Date.now();
  const urls = [
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${code}.tw&json=1&_=${ts}`,
    `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=otc_${code}.tw&json=1&_=${ts}`
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { "cache-control": "no-cache" } });
      const j = await r.json();
      if (j && j.msgArray && j.msgArray.length) {
        const it = j.msgArray[0];
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
    } catch (e) {}
  }
  return { ok:false };
}

// ---- 狀態（簡易記憶）----
const state = {
  mode: "auto", // auto | work
  remind: { bath:true, sleep:true },
  watch: new Set(["2355","2374","1815","2438","2027","2382","5314"]),
  holds: {
    "2618":"42.5","5905":"15","5202":"26.5","2884":"30.5","00687B":"31.5","00937B":"16"
  }
};

// ---- 指令處理 ----
async function handleCommand(chatId, text) {
  const t = text.trim();

  if (t === "/menu" || t === "menu") {
    return send(chatId,
`可用指令：
/上班  切到上班模式（僅重要推播）
/自動  平/假日自動判斷
/狀態  檢視目前設定
/股價  代號或名稱（例：/股價 2374 或 /股價 佳能）
/持股設定 代號 成本（例：/持股設定 2618 成本 35.5）
/追蹤新增 代號     /追蹤移除 代號
（也可輸入「查 2330」、「查 台積電」或點下方鍵）`);
  }

  if (t === "/上班" || t === "上班") { state.mode="work"; return send(chatId,"已切換：上班模式 ✅"); }
  if (t === "/自動" || t === "自動") { state.mode="auto"; return send(chatId,"已切換：自動模式 ✅"); }

  if (t === "/洗澡提醒開") { state.remind.bath = true;  return send(chatId,"21:30 洗澡提醒已啟用 ✅"); }
  if (t === "/洗澡提醒關") { state.remind.bath = false; return send(chatId,"21:30 洗澡提醒已關閉 ✅"); }
  if (t === "/睡覺提醒開") { state.remind.sleep = true;  return send(chatId,"23:00 睡覺提醒已啟用 ✅"); }
  if (t === "/睡覺提醒關") { state.remind.sleep = false; return send(chatId,"23:00 睡覺提醒已關閉 ✅"); }

  if (t === "/狀態" || t === "狀態") {
    return send(chatId,
`台北時間：${dayjs().format("YYYY-MM-DD HH:mm")}
模式：${state.mode}
洗澡提醒：${state.remind.bath?"開":"關"}（21:30）
睡覺提醒：${state.remind.sleep?"開":"關"}（23:00）`);
  }

  if (t === "clip 摘要 今日" || t === "/clip摘要今天" || t === "/clip摘要 今日") {
    return send(chatId, "Clip 功能位保留（之後接入）。");
  }
  if (t === "clip 清單" || t === "/clip清單") {
    return send(chatId, "Clip 功能位保留（之後接入）。");
  }

  if (t === "清單" || t === "/清單") {
    let s = "【追蹤清單】\n";
    if (state.watch.size === 0) s += "（空）\n";
    else { let i=1; for (const code of state.watch) s += `${i++}) ${code} ${ALIAS[code]||""}\n`; }
    s += "\n【持股清單（成本）】\n";
    const keys = Object.keys(state.holds);
    if (keys.length===0) s += "（空）\n";
    else { let i=1; for (const code of keys) s += `${i++}) ${code} ${ALIAS[code]||""}  成本 ${state.holds[code]}\n`; }
    return send(chatId, s);
  }

  if (/^\/追蹤新增\s+/.test(t)) {
    const arg = t.replace(/^\/追蹤新增\s+/,"").trim();
    const n = normalizeSymbol(arg);
    if (!n) return send(chatId, "格式：/追蹤新增 代號 或 名稱");
    state.watch.add(n.code);
    return send(chatId, `已加入追蹤：${n.code} ${n.name || ALIAS[n.code] || ""}`);
  }
  if (/^\/追蹤移除\s+/.test(t)) {
    const arg = t.replace(/^\/追蹤移除\s+/,"").trim();
    const n = normalizeSymbol(arg);
    if (!n) return send(chatId, "格式：/追蹤移除 代號 或 名稱");
    state.watch.delete(n.code);
    return send(chatId, `已自追蹤移除：${n.code} ${n.name || ALIAS[n.code] || ""}`);
  }

  if (/^\/持股設定\s+/.test(t)) {
    const m = t.match(/^\/持股設定\s+(\S+)\s+成本\s+(\S+)/);
    if (!m) return send(chatId, "格式：/持股設定 代號 成本 35.5");
    const n = normalizeSymbol(m[1]);
    if (!n) return send(chatId, "代號/名稱無法辨識。");
    state.holds[n.code] = String(m[2]);
    return send(chatId, `已設定持股 ${n.code} ${ALIAS[n.code] || ""} 成本 ${state.holds[n.code]} ✅`);
  }

  // 查價（多種語法）
  let q = null;
  let m1 = t.match(/^\/?(股價|查價|查)\s+(.+)$/);
  if (m1) q = m1[2].trim();
  if (!q && (t === "查價" || t === "/股價")) {
    return send(chatId, "請輸入：股價 代號 或 名稱（例：股價 2330、查 佳能）");
  }
  if (!q) {
    let m2 = t.match(/^(查|股價)\s*(.*)$/);
    if (m2 && m2[2]) q = m2[2].trim();
  }
  if (q) {
    const n = normalizeSymbol(q);
    if (!n) return send(chatId, "找不到對應的代號/名稱。");
    try {
      const r = await fetchDailyClose(n.code);
      if (!r.ok) return send(chatId, `【${n.code}】暫無取得到即時/日收資料，稍後再試。`);
      const line =
`【${n.code}｜${r.market}】 ${r.date} 收：${r.close}
(開:${r.open} 高:${r.high} 低:${r.low})`;
      return send(chatId, line);
    } catch (e) {
      console.error("price error:", e);
      return send(chatId, "查價發生錯誤，稍後再試。");
    }
  }

  return send(chatId, `收到：「${t}」`);
}

// ---- HTTP 路由 ----
app.get("/", (_req, res) => {
  res.json({ ok:true, service:"orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") });
});
app.get("/health", (_req, res) => {
  res.json({ ok:true, service:"orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") });
});
app.get("/ping", async (req, res) => {
  try {
    const target = req.query.chat_id || CHAT_ID;
    if (!target) return res.status(400).json({ ok:false, msg:"no CHAT_ID" });
    const j = await tgSend(target, req.query.text || "HelloFromWebhook", replyKeyboard());
    res.json({ ok:true, result: j.result || j });
  } catch {
    res.status(200).json({ ok:false, msg:"ping failed" });
  }
});

// ---- Telegram webhook：先交給 link_listener，再跑原流程 ----
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  const run = async () => {
    try {
      const update = req.body;

      const handled = await handleLinkUpdate(
        update,
        (chatId, text) => send(chatId, text),
        {
          clipSummary: async (chatId, link) => {
            // TODO：換成你的 clip 摘要流程
            return send(chatId, `🔗 偵測到連結，準備摘要：\n${link}`);
          }
        }
      );
      if (handled) return;

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

      await handleCommand(chatId, text);
    } catch (e) {
      console.error("webhook handler error:", e);
    }
  };
  if (typeof queueMicrotask === "function") queueMicrotask(run);
  else setImmediate(run);
});

// ---- 定時推播（Asia/Taipei）例：07:40/08:55 佔位 ----
cron.schedule("40 7 * * 1-5", async () => {
  if (CHAT_ID && (state.mode === "work" || state.mode === "auto")) {
    await send(CHAT_ID, `【盤前導航｜07:40】\n• （佔位）今日重點稍後更新`);
  }
});
cron.schedule("55 8 * * 1-5", async () => {
  if (CHAT_ID && (state.mode === "work" || state.mode === "auto")) {
    await send(CHAT_ID, `【開盤補充｜08:55】\n• （佔位）開盤觀察稍後更新`);
  }
});

// ---- Render 需要 listen(PORT) 才算啟動成功 ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
