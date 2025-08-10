// webhook_server.js — 安全＋自檢版
// Node 18+（原生 fetch）
const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const { BOT_TOKEN, CHAT_ID, BASE_URL } = require("./env");
const { setWebhook, pingSelf, hello } = require("./startup-check");

dayjsBase.extend(utc);
dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const app = express();
app.use(express.json());

// ---------- 安全發訊（含限流重試&清楚錯誤） ----------
async function sendWithRetry(url, payload, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) return res.json();

      if (res.status === 429) {
        const data = await res.json().catch(()=> ({}));
        const wait = (data.parameters?.retry_after ?? 1) * 1000;
        console.warn(`⚠️ 429，${wait}ms 後重試（${i}/${tries}）`);
        await new Promise(r=>setTimeout(r, wait));
        continue;
      }
      if (res.status === 401) throw new Error("401 Token 失效：請到 BotFather 旋轉新 Token");
      if (res.status === 404) throw new Error("404 API/路徑錯：檢查 setWebhook URL 是否正確");
      const msg = await res.text();
      throw new Error(`HTTP ${res.status}: ${msg}`);
    } catch (err) {
      if (i === tries) {
        console.error(`[TG] send 失敗（已重試 ${tries} 次）→`, err.message);
        return { ok:false, error: err.message };
      }
      const backoff = 800 * Math.pow(2, i-1);
      console.warn(`[TG] 發送失敗，${backoff}ms 後重試（${i+1}/${tries} 次）→ ${err.message}`);
      await new Promise(r=>setTimeout(r, backoff));
    }
  }
}
const send = (chatId, text, extra={}) =>
  sendWithRetry(`${TG_API}/sendMessage`, { chat_id: chatId, text, ...extra });

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

// ---------- 名稱 / 代號 對照 ----------
const ALIAS = {
  // 你的持股
  "2618":"長榮航","長榮航":"2618",
  "5905":"南仁湖","南仁湖":"5905",
  "5202":"力新","力新":"5202",
  "2884":"玉山金","玉山金":"2884",
  "00687B":"國泰20年美債","國泰20年美債":"00687B",
  "00937B":"群益投資級債","群益投資級債":"00937B",
  // 追蹤
  "2355":"敬鵬","敬鵬":"2355",
  "2374":"佳能","佳能":"2374",
  "1815":"富喬","富喬":"1815",
  "2438":"翔耀","翔耀":"2438",
  "2027":"大成鋼","大成鋼":"2027",
  "2382":"廣達","廣達":"2382",
  "5314":"世紀","世紀":"5314",
  // 常見
  "2330":"台積電","台積電":"2330",
  "2317":"鴻海","鴻海":"2317",
};

function normalizeSymbol(inputRaw) {
  const s = String(inputRaw).trim().toUpperCase();
  if (/^\d{4,5}[A-Z]*$/.test(s)) return { code:s, name: ALIAS[s] || null };
  const code = ALIAS[s] || null;
  if (code) return { code, name: s };
  return null;
}

// ---------- 即時/收盤價格（TWSE/TPEx 容錯） ----------
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function fetchRealtime(code, exHint=null) {
  const exList = exHint ? [exHint, exHint==="tse"?"otc":"tse"] : ["tse","otc"];
  for (const ex of exList) {
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex}_${code}.tw`;
    try {
      const r = await fetch(url, { headers:{ "cache-control":"no-cache" }});
      const j = await r.json();
      if (Array.isArray(j.msgArray) && j.msgArray.length) {
        const m = j.msgArray[0];
        const price = m.z && m.z !== "-" ? m.z : (m.y && m.y !== "-" ? m.y : null);
        const open  = m.o && m.o !== "-" ? m.o : null;
        const high  = m.h && m.h !== "-" ? m.h : null;
        const low   = m.l && m.l !== "-" ? m.l : null;
        if (price) return { ok:true, ex, name:m.n, code:m.c, price, open, high, low, date: m.d || dayjs().format("YYYY/MM/DD") };
      }
    } catch {}
    await sleep(60);
  }
  return { ok:false };
}

// ---------- 分享來源偵測（FB/LINE/TG/YT/X…） ----------
function extractUrls(text) {
  const urls=[], re=/(https?:\/\/[^\s]+)/gi; let m;
  while((m=re.exec(text))!==null) urls.push(m[1]);
  return urls;
}
function detectShareSource(text) {
  const urls = extractUrls(text);
  if (!urls.length) return null;
  const u = urls[0];
  let host="";
  try { host = new URL(u).host.replace(/^www\./,''); } catch {}
  let source = "url";
  if (/facebook\.com|m\.facebook\.com|fb\.watch/.test(host)) source = "facebook";
  else if (/line\.me|lin\.ee|liff\.line/.test(host))        source = "line";
  else if (/t\.me|telegram\.me/.test(host))                  source = "telegram";
  else if (/youtube\.com|youtu\.be/.test(host))              source = "youtube";
  else if (/x\.com|twitter\.com/.test(host))                 source = "x";
  return { source, url: u, host };
}
const shareQueue = [];

// ---------- 狀態 ----------
const state = {
  mode: "auto",
  lastJournalDoneDate: null,
  remind: { bath:true, sleep:true },
  watch: new Set(["2355","2374","1815","2438","2027","2382","5314"]),
  holds: {
    "2618":"42.5","5905":"15","5202":"26.5","2884":"30.5","00687B":"31.5","00937B":"16"
  }
};

// ---------- 指令處理 ----------
function KB() { return { ...replyKeyboard() }; }

async function handleCommand(chatId, text) {
  const t = text.trim();

  if (t === "/menu" || t.toLowerCase()==="menu") {
    return send(chatId,
`可用指令：
/上班  只推重要訊息（08:00-17:00）
/自動  平/假日自動判斷
/狀態  檢視目前設定
/股價  代號或名稱（例：/股價 2374 或 /股價 佳能）
/持股設定 代號 成本（例：/持股設定 2618 成本 35.5）
/追蹤新增 代號   /追蹤移除 代號
/洗澡提醒開｜/洗澡提醒關
/睡覺提醒開｜/睡覺提醒關
（也可直接輸入：查 2330、股價 佳能、查價 2618）`, KB());
  }

  if (t === "/上班" || t === "上班") { state.mode="work"; return send(chatId,"已切換：上班模式 ✅",KB()); }
  if (t === "/自動" || t === "自動") { state.mode="auto"; return send(chatId,"已切換：自動模式 ✅",KB()); }

  if (t === "/狀態" || t === "狀態") {
    return send(chatId,
`台北時間：${dayjs().format("YYYY-MM-DD HH:mm")}
模式：${state.mode}
上班：平日 08:00–17:00
盤前導航：07:40（平日）
開盤補充：08:55（平日）
日誌提醒：平日16:30；週末21:00；隔日07:30
洗澡提醒：${state.remind.bath?"開":"關"}（21:30）
睡覺提醒：${state.remind.sleep?"開":"關"}（23:00）`, KB());
  }

  if (t === "clip 摘要 今日") return send(chatId,"Clip 功能位保留（之後接入）。",KB());

  if (t === "清單" || t === "/清單") {
    let s="【追蹤】\n";
    if (state.watch.size===0) s+="（空）\n";
    else {
      let i=1; for (const c of state.watch) s+=`${i++}) ${c} ${ALIAS[c]||""}\n`;
    }
    s+="\n【持股（成本）】\n";
    const ks=Object.keys(state.holds);
    if (ks.length===0) s+="（空）\n";
    else {
      let i=1; for (const c of ks) s+=`${i++}) ${c} ${ALIAS[c]||""}  成本 ${state.holds[c]}\n`;
    }
    return send(chatId,s,KB());
  }

  if (/^\/追蹤新增\s+/.test(t)) {
    const arg = t.replace(/^\/追蹤新增\s+/,"").trim();
    const n = normalizeSymbol(arg); if (!n) return send(chatId,"格式：/追蹤新增 代號 或 名稱",KB());
    state.watch.add(n.code);
    return send(chatId,`已加入追蹤：${n.code} ${ALIAS[n.code]||n.name||""}`,KB());
  }
  if (/^\/追蹤移除\s+/.test(t)) {
    const arg = t.replace(/^\/追蹤移除\s+/,"").trim();
    const n = normalizeSymbol(arg); if (!n) return send(chatId,"格式：/追蹤移除 代號 或 名稱",KB());
    state.watch.delete(n.code);
    return send(chatId,`已自追蹤移除：${n.code} ${ALIAS[n.code]||n.name||""}`,KB());
  }

  if (t === "/洗澡提醒開")  { state.remind.bath=true;  return send(chatId,"21:30 洗澡提醒已啟用 ✅",KB()); }
  if (t === "/洗澡提醒關")  { state.remind.bath=false; return send(chatId,"21:30 洗澡提醒已關閉 ✅",KB()); }
  if (t === "/睡覺提醒開")  { state.remind.sleep=true;  return send(chatId,"23:00 睡覺提醒已啟用 ✅",KB()); }
  if (t === "/睡覺提醒關")  { state.remind.sleep=false; return send(chatId,"23:00 睡覺提醒已關閉 ✅",KB()); }

  // 股價（/股價 xxx、股價 xxx、查價 xxx、查 xxx）
  let q=null; {
    let m=t.match(/^\/?(股價|查價|查)\s+(.+)$/); if (m) q=m[2].trim();
    if (!q){ let m2=t.match(/^(查|股價)\s*(.*)$/); if (m2 && m2[2]) q=m2[2].trim(); }
  }
  if (t==="查價" || t==="/股價") return send(chatId,"請輸入：股價 代號 或 名稱（例：股價 2330、查 佳能）",KB());
  if (q){
    const n = normalizeSymbol(q);
    if (!n) return send(chatId,"找不到對應代號/名稱。",KB());
    try{
      const r = await fetchRealtime(n.code, null);
      if (!r.ok) return send(chatId,`【${n.code}】暫時取不到報價。`,KB());
      const line = `【${r.code}｜${r.name}】 ${r.date} 收：${r.price}（開:${r.open??"-"} 高:${r.high??"-"} 低:${r.low??"-"}）`;
      return send(chatId,line,KB());
    }catch(e){
      console.error("price error:", e);
      return send(chatId,"查價發生錯誤，稍後再試。",KB());
    }
  }

  // 持股設定
  if (/^\/持股設定\s+/.test(t)) {
    const m = t.match(/^\/持股設定\s+(\S+)\s+成本\s+(\S+)/);
    if (!m) return send(chatId,"格式：/持股設定 代號 成本 35.5",KB());
    const n = normalizeSymbol(m[1]); if (!n) return send(chatId,"代號/名稱無法辨識。",KB());
    state.holds[n.code] = String(m[2]);
    return send(chatId,`已設定持股 ${n.code} ${ALIAS[n.code]||""} 成本 ${state.holds[n.code]} ✅`,KB());
  }

  // 其他：普通訊息
  return send(chatId, `收到：「${t}」`, KB());
}

// ---------- HTTP ----------
app.get("/", (req,res)=>res.send({ ok:true, service:"orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") }));
app.get("/health",(req,res)=>res.json({ ok:true, service:"orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") }));
app.get("/ping", async (req,res)=>{
  try{
    const j = await send(CHAT_ID, req.query.text || "Ping ✅", KB());
    res.json({ ok:true, result: j });
  }catch(e){ res.status(200).json({ ok:false, msg:"ping failed" });}
});

// ---------- Webhook ----------
app.post("/webhook", (req,res)=>{
  res.sendStatus(200);
  const run = async ()=>{
    try{
      const up = req.body;
      const msg = up.message || up.edited_message || up.channel_post || up.edited_channel_post;
      if (!msg) return;
      const chatId = String(msg.chat?.id||"");
      const text = (msg.text || msg.caption || "").trim();
      if (!text) return send(chatId,"（非文字訊息）",KB());

      // 先檢查是否分享連結
      const share = detectShareSource(text);
      if (share) {
        shareQueue.push({ time: dayjs().format("YYYY-MM-DD HH:mm:ss"), ...share, raw:text });
        await send(chatId,
          `【已收到分享】來源：${share.source.toUpperCase()}\n${share.url}\n\n`+
          `▶ 盤中：先做即時摘要（規則/模型待接）\n▶ 收盤：彙整入戀股資料庫（佔位）`, KB());
        return;
      }

      // 指令/查價/清單…
      await handleCommand(chatId, text);
    }catch(e){ console.error("webhook handler error:", e); }
  };
  typeof queueMicrotask==="function" ? queueMicrotask(run) : setImmediate(run);
});

// ---------- 定時（台北時區） ----------
cron.schedule("40 7 * * 1-5", async () => {
  try {
    if ([1,2,3,4,5].includes(dayjs().day())) {
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

cron.schedule("55 8 * * 1-5", async () => {
  try {
    if ([1,2,3,4,5].includes(dayjs().day())) {
      await send(CHAT_ID,
`【開盤補充｜08:55】
• 集合競價/委託量
• 早盤異常股
（模板）`);
    }
  } catch (e) { console.error("08:55 push error", e); }
}, { timezone:"Asia/Taipei" });

cron.schedule("30 16 * * 1-5", async () => {
  try {
    if ([1,2,3,4,5].includes(dayjs().day())) {
      await send(CHAT_ID, "【提醒】收盤囉～要不要記今天的戀股日誌？（回覆 /日誌完成）");
    }
  } catch (e) { console.error("16:30 reminder error", e); }
}, { timezone:"Asia/Taipei" });

cron.schedule("0 21 * * 6,0", async () => {
  try { await send(CHAT_ID, "【提醒】今晚要不要補本週的戀股日誌與策略？（/日誌完成）"); }
  catch (e) { console.error("21:00 weekend reminder error", e); }
}, { timezone:"Asia/Taipei" });

cron.schedule("30 7 * * *", async () => {
  try {
    const yesterday = dayjs().subtract(1,"day").format("YYYY-MM-DD");
    if (state.lastJournalDoneDate === yesterday) return;
    await send(CHAT_ID, `【補提醒｜07:30】你昨天（${yesterday}）的戀股日誌還沒完成喔～（/日誌完成）`);
  } catch (e) { console.error("07:30 backfill error", e); }
}, { timezone:"Asia/Taipei" });

cron.schedule("30 21 * * *", async () => {
  try { if (state.remind.bath)  await send(CHAT_ID, "21:30 到啦～去洗香香🛁"); }
  catch (e) { console.error("21:30 bath remind error", e); }
}, { timezone:"Asia/Taipei" });

cron.schedule("0 23 * * *", async () => {
  try { if (state.remind.sleep) await send(CHAT_ID, "23:00～準備上床睡覺 😴"); }
  catch (e) { console.error("23:00 sleep remind error", e); }
}, { timezone:"Asia/Taipei" });

// ---------- 啟動＆自檢 ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ listening on ${PORT}`);
  try {
    await pingSelf(BASE_URL);
    await setWebhook(BASE_URL, TG_API);
    await hello(TG_API, CHAT_ID);
    console.log("🟢 Startup checks done");
  } catch (e) {
    console.error("❌ Startup checks failed:", e.message);
    process.exit(1); // 讓 Render 自動重啟，直到設好為止
  }
});
