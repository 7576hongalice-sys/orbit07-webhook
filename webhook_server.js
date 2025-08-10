// Node 18+：內建 fetch
const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

// ---- Day.js：固定台北時區 ----
dayjsBase.extend(utc);
dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

// ================== 基本設定 ==================
const TOKEN   = process.env.BOT_TOKEN || "8279562243:AAEyhzGPAy7FeK-TvJQAbwhAPVLHXG_z2gY";
const TG_API  = `https://api.telegram.org/bot${TOKEN}`;
const CORE_CHAT_ID = process.env.CHAT_ID || "8418229161"; // 你本人（私訊/私密提醒）

const CORE_SUBSCRIBERS = new Set([CORE_CHAT_ID]);   // 私密通道
const STOCKS_SUBSCRIBERS = new Set([CORE_CHAT_ID]); // 戀股主場TG（先同你，日後可加媽媽/群）

// ================== 名稱↔代號（輕量全名版） ==================
// 先放：你的持股/追蹤 + 常見大票（可隨時用 /教別名 補充）
const NAME_ALIASES = {
  // —— 你的清單 ——
  "長榮航": "2618", "南仁湖": "5905", "力新": "5202", "玉山金": "2884",
  "佳能": "2374", "敬鵬": "2355", "富喬": "1815", "世紀": "5314", "翔耀": "2438", "廣達": "2382", "大成鋼": "2027",
  "00687B": "00687B", "00937B": "00937B",

  // —— 常見大票（節錄，可再補） ——
  "台積電": "2330", "臺積電": "2330", "台積": "2330", "TSMC": "2330",
  "鴻海": "2317", "聯發科": "2454", "台達電": "2308", "聯電": "2303",
  "中鋼": "2002", "富邦金": "2881", "國泰金": "2882", "台泥": "1101", "亞泥": "1102",
  "大立光": "3008", "聯詠": "3034", "日月光": "3711", "華碩": "2357", "宏碁": "2353",
  "緯創": "3231", "技嘉": "2376", "光寶科": "2301", "群創": "3481", "友達": "2409",
  "長榮": "2603", "陽明": "2609", "萬海": "2615", "華航": "2610"
};
// 顯示用：代號→名稱（缺的先留空字串）
const CODE_TO_NAME = {
  "2618": "長榮航", "5905": "南仁湖", "5202": "力新", "2884": "玉山金",
  "2374": "佳能", "2355": "敬鵬", "1815": "富喬", "5314": "世紀", "2438": "翔耀", "2382": "廣達", "2027": "大成鋼",
  "00687B": "國泰20年美債", "00937B": "群益ESG投等債20+",

  "2330": "台積電", "2317": "鴻海", "2454": "聯發科", "2308": "台達電", "2303": "聯電",
  "2002": "中鋼", "2881": "富邦金", "2882": "國泰金", "1101": "台泥", "1102": "亞泥",
  "3008": "大立光", "3034": "聯詠", "3711": "日月光投控", "2357": "華碩", "2353": "宏碁",
  "3231": "緯創", "2376": "技嘉", "2301": "光寶科", "3481": "群創", "2409": "友達",
  "2603": "長榮", "2609": "陽明", "2615": "萬海", "2610": "華航"
};

// 正規化：去空白、台→臺、全大寫（方便比對）
const normalizeName = s => (s || "").trim().replace(/\s+/g, "").replace(/台/g, "臺").toUpperCase();
function showCodeName(code) {
  const nm = CODE_TO_NAME[code] || "";
  return nm ? `${code} ${nm}` : `${code}`;
}

// 把名稱解析為代號；找不到時回 null
function resolveToCode(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (/^\d{4,5}[A-Z]?$/i.test(raw)) return raw.toUpperCase(); // 已是代號
  const norm = normalizeName(raw);
  if (NAME_ALIASES[norm]) return NAME_ALIASES[norm];

  // 模糊：包含/被包含
  for (const [name, code] of Object.entries(NAME_ALIASES)) {
    const nn = normalizeName(name);
    if (nn.includes(norm) || norm.includes(nn)) return code;
  }
  return null;
}

// 搜尋候選（找不到唯一代號時提供前 5 筆）
function searchCandidates(keyword, limit = 5) {
  const norm = normalizeName(keyword);
  if (!norm) return [];
  const scored = [];
  for (const [name, code] of Object.entries(NAME_ALIASES)) {
    const nn = normalizeName(name);
    let score = 0;
    if (nn === norm) score = 100;              // 完全相同
    else if (nn.startsWith(norm)) score = 80;  // 前綴
    else if (nn.includes(norm)) score = 60;    // 內含
    else if (norm.includes(nn)) score = 50;    // 反向包含（你打的比較長）
    if (score > 0) scored.push({ name, code, score });
  }
  scored.sort((a,b)=>b.score - a.score);
  const uniq = [];
  const seen = new Set();
  for (const s of scored) {
    if (seen.has(s.code)) continue;
    seen.add(s.code);
    uniq.push(s);
    if (uniq.length >= limit) break;
  }
  return uniq;
}

// 動態新增別名：/教別名 代號 名稱
function teachAlias(code, name) {
  const c = String(code || "").toUpperCase().trim();
  const n = String(name || "").trim();
  if (!/^\d{4,5}[A-Z]?$/i.test(c) || !n) return false;
  const norm = normalizeName(n);
  NAME_ALIASES[norm] = c;
  if (!CODE_TO_NAME[c]) CODE_TO_NAME[c] = n;
  return true;
}

// ================== 環境狀態 / 功能開關 ==================
const state = {
  mode: "auto",                    // auto | work
  oralQueryEnabled: true,          // 口語查價（私聊）
  clipboxEnabled: true,            // 轉貼＝即時分析＋入庫
  cooldownMinutes: 0,              // 速報冷卻（分鐘）；0 = 不節流
  washReminderOn: true,
  sleepReminderOn: true,
  lastJournalDoneDate: null,       // YYYY-MM-DD
  lastPushAtBySource: new Map()    // 速報冷卻用：來源→時間
};

// ================== Telegram 基本工具 ==================
async function tgSend(chatId, text, options = {}) {
  const url = `${TG_API}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: "HTML", ...options };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}
async function tgReplyKeyboard(chatId) {
  const keyboard = [
    [{ text: "查價" }, { text: "清單" }, { text: "追蹤收盤" }],
    [{ text: "clip摘要 今日" }, { text: "clip清單" }],
    [{ text: "狀態" }, { text: "上班" }, { text: "自動" }],
    [{ text: "洗澡提醒" }, { text: "睡覺提醒" }]
  ];
  return tgSend(chatId, "功能列已就緒，直接點按即可；也可輸入「查佳能」「股價 2330」。", {
    reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: false }
  });
}
async function tgForceAskCodeName(chatId) {
  return tgSend(chatId, "請輸入「代號或名稱」：", {
    reply_markup: { force_reply: true, input_field_placeholder: "例如：2374 或 佳能" }
  });
}
async function notifyCore(text)  { for (const id of CORE_SUBSCRIBERS)   { try { await tgSend(id, text); } catch(_){} } }
async function notifyStocks(text){ for (const id of STOCKS_SUBSCRIBERS) { try { await tgSend(id, text); } catch(_){} } }

// ================== 行情抓取（收盤後 OHLC） ==================
async function fetchTwseMonthly(code, anyDay = new Date()) {
  const y = dayjs(anyDay).format("YYYY");
  const m = dayjs(anyDay).format("MM");
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${y}${m}01&stockNo=${code}`;
  const r = await fetch(url, { headers: { "Accept": "application/json" }});
  if (!r.ok) return null;
  const j = await r.json().catch(()=>null);
  if (!j || j.stat !== "OK" || !Array.isArray(j.data)) return null;
  let last = null;
  for (const row of j.data) {
    const [d, , , open, high, low, close] = row;
    const o = Number(String(open).replace(/[,--]/g,""));
    const h = Number(String(high).replace(/[,--]/g,""));
    const l = Number(String(low).replace(/[,--]/g,""));
    const c = Number(String(close).replace(/[,--]/g,""));
    if (!isFinite(c) || c === 0) continue;
    last = { date: d, open: o, high: h, low: l, close: c, source: "TWSE" };
  }
  return last;
}
async function fetchTpexMonthly(code, anyDay = new Date()) {
  const rocY = (dayjs(anyDay).year() - 1911).toString();
  const mm = dayjs(anyDay).format("MM");
  const rocYm = `${rocY}/${mm}`;
  const url = `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=${rocYm}&stkno=${code}`;
  const r = await fetch(url, { headers: { "Accept": "application/json" }});
  if (!r.ok) return null;
  const j = await r.json().catch(()=>null);
  const arr = j?.aaData || j?.data || [];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  let last = null;
  for (const row of arr) {
    const d = String(row[0] || "").trim();
    const open = Number(String(row[3] || "").replace(/[,--]/g,""));
    const high = Number(String(row[4] || "").replace(/[,--]/g,""));
    const low  = Number(String(row[5] || "").replace(/[,--]/g,""));
    const close= Number(String(row[6] || "").replace(/[,--]/g,""));
    if (!isFinite(close) || close === 0) continue;
    last = { date: d, open, high, low, close, source: "TPEx" };
  }
  return last;
}
async function getDailyOHLC(code) {
  const tw = await fetchTwseMonthly(code).catch(()=>null);
  if (tw) return tw;
  const tp = await fetchTpexMonthly(code).catch(()=>null);
  if (tp) return tp;
  return null;
}

// ================== ClipBox（轉貼＝即時分析＋入庫） ==================
const clips = [];
function sourceGuess(msg) {
  const fwdFrom = msg.forward_from_chat?.title || msg.forward_from?.username || msg.forward_sender_name;
  if (fwdFrom) return fwdFrom;
  const text = (msg.text || msg.caption || "");
  const urls = (text.match(/https?:\/\/\S+/g) || []).join(" ").toLowerCase();
  if (urls.includes("facebook.com") || urls.includes("fb.watch")) return "Facebook";
  if (urls.includes("t.me/")) return "Telegram";
  if (urls.includes("line.me") || urls.includes("liff.line.me") || urls.includes("today.line.me")) return "LINE";
  return null;
}
function quickTLDR(text) {
  const lines = String(text || "").split(/\n+/).map(s=>s.trim()).filter(Boolean);
  const top = lines.slice(0, 3);
  const tickers = new Set();
  (text.match(/\b\d{4,5}[A-Z]?\b/g) || []).forEach(v => tickers.add(v.toUpperCase()));
  for (const [name, code] of Object.entries(NAME_ALIASES)) {
    const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (re.test(text)) tickers.add(code);
  }
  const tickList = Array.from(tickers).map(c => showCodeName(c)).join("、");
  return { bullets: top, tickers: Array.from(tickers), tickList };
}
function withinCooldown(sourceKey) {
  if (!state.cooldownMinutes || state.cooldownMinutes <= 0) return false;
  const now = Date.now();
  const last = state.lastPushAtBySource.get(sourceKey || "general") || 0;
  const diffMin = (now - last) / 60000;
  if (diffMin < state.cooldownMinutes) return true;
  state.lastPushAtBySource.set(sourceKey || "general", now);
  return false;
}
async function handleClipAndInstantReply(msg) {
  if (!state.clipboxEnabled) return;
  const chatId = String(msg.chat.id);

  let src = sourceGuess(msg);
  if (!src) src = "未標記來源";

  const text = (msg.text || msg.caption || "(無文字內容)");
  const tldr = quickTLDR(text);

  const rec = {
    time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    from_chat: msg.chat.title || msg.chat.username || msg.chat.first_name || "",
    source: src,
    text,
    tickers: tldr.tickers
  };
  clips.push(rec);

  const header = `【即時解析】${src}｜${rec.time}`;
  if (withinCooldown(src)) {
    await tgSend(chatId, `${header}\n（已收錄，多則來訊節流中…）\n抓到標的：${tldr.tickList || "—"}`);
    return;
  }
  const bullets = tldr.bullets.length ? tldr.bullets.map((b,i)=>`${i+1}. ${b}`).join("\n") : "（暫無文字重點）";
  const body = `${header}\n${bullets}\n\n抓到標的：${tldr.tickList || "—"}`;
  await tgSend(chatId, body);
}

// ================== 指令處理 ==================
async function handleCommand(chatId, text, msg) {
  const askCodeFlow = () => tgForceAskCodeName(chatId);

  if (text === "/start" || text === "/menu") {
    await tgReplyKeyboard(chatId);
    return tgSend(chatId,
`可用指令：
/上班  只推重要訊息（08:00-17:00）
/自動  平/假日自動判斷
/狀態  檢視目前設定
/股價  代號或名稱（例：/股價 2374 或 /股價 佳能）
/查代號 關鍵字（例：/查代號 台積）
/教別名 代號 名稱（例：/教別名 2374 佳能）
/口語查價開｜/口語查價關
/clip開｜/clip關
/速報冷卻 分鐘（例：/速報冷卻 10）`);
  }

  // 模式
  if (text === "/上班") { state.mode = "work"; return tgSend(chatId, "已切換：上班模式 ✅"); }
  if (text === "/自動") { state.mode = "auto"; return tgSend(chatId, "已切換：自動模式 ✅"); }

  // 開關
  if (text === "/口語查價開") { state.oralQueryEnabled = true;  return tgSend(chatId, "口語查價：已開啟 ✅（私聊可用：查佳能/股價 2330）"); }
  if (text === "/口語查價關") { state.oralQueryEnabled = false; return tgSend(chatId, "口語查價：已關閉 ⛔"); }
  if (text === "/clip開")      { state.clipboxEnabled = true;    return tgSend(chatId, "ClipBox：已開啟 ✅（轉貼＝即時分析＋入庫）"); }
  if (text === "/clip關")      { state.clipboxEnabled = false;   return tgSend(chatId, "ClipBox：已關閉 ⛔"); }

  if (text.startsWith("/速報冷卻")) {
    const n = parseInt(text.split(/\s+/)[1] || "0", 10);
    state.cooldownMinutes = isFinite(n) && n >= 0 ? n : 0;
    return tgSend(chatId, `速報冷卻：${state.cooldownMinutes} 分鐘`);
  }

  if (text === "/狀態") {
    return tgSend(chatId,
`模式：${state.mode}
台北時間：${dayjs().format("YYYY-MM-DD HH:mm")}
口語查價：${state.oralQueryEnabled ? "開" : "關"}
ClipBox：${state.clipboxEnabled ? "開" : "關"}
速報冷卻：${state.cooldownMinutes} 分
（查價支援「代號或名稱」，顯示一律「代號 名稱」）`);
  }

  // 查代號（候選清單）
  if (text.startsWith("/查代號")) {
    const q = text.split(/\s+/).slice(1).join(" ").trim();
    if (!q) return tgSend(chatId, "請給我關鍵字，例如：/查代號 台積");
    const cand = searchCandidates(q, 8);
    if (cand.length === 0) return tgSend(chatId, `找不到與「${q}」相關的公司名稱。`);
    const lines = cand.map((c,i)=>`${i+1}. ${showCodeName(c.code)}（${c.name}）`).join("\n");
    return tgSend(chatId, `可能是以下其中之一：\n${lines}\n\n要查價請輸入「/股價 代號」或直接回覆代號。`);
  }

  // 教別名
  if (text.startsWith("/教別名")) {
    const parts = text.split(/\s+/);
    const code = parts[1], name = parts.slice(2).join(" ");
    if (!code || !name) return tgSend(chatId, "用法：/教別名 代號 名稱\n例如：/教別名 2374 佳能");
    const ok = teachAlias(code, name);
    return tgSend(chatId, ok ? `已新增別名：${showCodeName(code)} ⇄ ${name}` : "格式不正確，請再試一次。");
  }

  // 查價（按鈕或指令）
  if (text === "查價") return askCodeFlow();
  if (text.startsWith("/股價")) {
    const q = text.split(/\s+/).slice(1).join(" ");
    return doPriceQuery(chatId, q);
  }

  // 其他快捷鍵
  if (text === "清單")         return tgSend(chatId, "（示意）你的清單：\n2374 佳能\n2355 敬鵬\n1815 富喬\n2438 翔耀\n2027 大成鋼");
  if (text === "追蹤收盤")     return tgSend(chatId, "（提示）16:30 後查最準；我會自動推播今日收盤彙整給你。");
  if (text === "clip清單")      return showClipList(chatId);
  if (text === "clip摘要 今日") return showClipSummary(chatId);
  if (text === "上班")          { state.mode = "work"; return tgSend(chatId, "已切換：上班模式 ✅"); }
  if (text === "自動")          { state.mode = "auto"; return tgSend(chatId, "已切換：自動模式 ✅"); }
  if (text === "洗澡提醒")      { state.washReminderOn = !state.washReminderOn; return tgSend(chatId, `21:30 洗澡提醒：${state.washReminderOn ? "已開" : "已關"}`); }
  if (text === "睡覺提醒")      { state.sleepReminderOn = !state.sleepReminderOn; return tgSend(chatId, `23:00 就寢提醒：${state.sleepReminderOn ? "已開" : "已關"}`); }

  return null;
}

// 查價核心（支援名稱→代號；找不到時給候選）
async function doPriceQuery(chatId, query) {
  const q = (query || "").trim();
  if (!q) return tgSend(chatId, "請提供「代號或名稱」，例如：/股價 2374 或 /股價 佳能");

  const code = resolveToCode(q);
  if (!code) {
    const cand = searchCandidates(q, 8);
    if (cand.length === 0) {
      return tgSend(chatId, `找不到「${q}」對應代號。\n你可用 /查代號 關鍵字 試試，或用 /教別名 代號 名稱 直接教我。`);
    }
    const lines = cand.map((c,i)=>`${i+1}. ${showCodeName(c.code)}（${c.name}）`).join("\n");
    return tgSend(chatId, `可能是以下其中之一：\n${lines}\n\n要查價請輸入「/股價 代號」。`);
  }

  const ohlc = await getDailyOHLC(code).catch(()=>null);
  if (!ohlc) return tgSend(chatId, `查不到 ${showCodeName(code)} 的收盤資料，可能尚未更新或非上市櫃。`);

  const { date, open, high, low, close, source } = ohlc;
  const body = `【${showCodeName(code)}｜${source}】
日期：${date}
開盤：${open}
最高：${high}
最低：${low}
收盤：${close}`;
  return tgSend(chatId, body);
}

// ClipBox：清單/摘要
async function showClipList(chatId) {
  if (clips.length === 0) return tgSend(chatId, "ClipBox 目前沒有新收錄。");
  const last = clips.slice(-5).map((c,i)=>`${i+1}. ${c.time}｜${c.source}｜抓到：${(c.tickers||[]).map(showCodeName).join("、") || "—"}`).join("\n");
  return tgSend(chatId, `最近 5 則：\n${last}`);
}
async function showClipSummary(chatId) {
  if (clips.length === 0) return tgSend(chatId, "今日尚無可摘要的資料。");
  const today = dayjs().format("YYYY-MM-DD");
  const items = clips.filter(c => c.time.startsWith(today)).slice(-10);
  if (items.length === 0) return tgSend(chatId, "今天尚無新資料。");
  const lines = [];
  items.forEach((c, i) => {
    const pick = String(c.text || "").split("\n").map(s=>s.trim()).filter(Boolean).slice(0,2).join(" / ");
    const tickList = (c.tickers||[]).map(showCodeName).join("、") || "—";
    lines.push(`${i+1}. ${c.time}｜${c.source}｜${pick || "（無重點）"}｜標的：${tickList}`);
  });
  return tgSend(chatId, `【ClipBox 摘要｜今日】\n${lines.join("\n")}`);
}

// ================== 伺服器與 Webhook ==================
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.json({ ok: true, service: "orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") }));
app.get("/health", (req, res) => res.json({ ok: true, service: "orbit07-webhook", now_taipei: dayjs().format("YYYY-MM-DD HH:mm:ss") }));
app.get("/ping", async (req, res) => {
  const t = req.query.text || "Ping ✅";
  try { const j = await tgSend(CORE_CHAT_ID, t); return res.json(j); }
  catch (e) { console.error("ping error:", e); return res.status(500).send("ping failed"); }
});

app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  const run = async () => {
    try {
      const update = req.body;
      const msg = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
      if (!msg) return;

      const chatId = String(msg.chat.id);
      const text = (msg.text || msg.caption || "").trim();

      // 1) 指令
      if (text.startsWith("/")) {
        await handleCommand(chatId, text, msg);
        if (text === "/start" || text === "/menu") await tgReplyKeyboard(chatId);
        return;
      }

      // 2) 強制回覆（查價）
      const isReplyToAsk = msg.reply_to_message && /請輸入「代號或名稱」/.test(msg.reply_to_message.text || "");
      if (isReplyToAsk) return doPriceQuery(chatId, text);

      // 3) 私聊口語查價（查/股價/查價/看 + 名稱或代號）
      const isPrivate = msg.chat.type === "private";
      if (isPrivate && state.oralQueryEnabled) {
        const m = text.match(/^(查|股價|查價|看)\s*([A-Za-z0-9\u4e00-\u9fa5\-\(\)]+)$/);
        if (m) return doPriceQuery(chatId, m[2]);
      }

      // 4) 其餘：當 ClipBox 內容處理（即時解析＋入庫）
      await handleClipAndInstantReply(msg);
    } catch (e) { console.error("webhook handler error:", e); }
  };
  if (typeof queueMicrotask === "function") queueMicrotask(run); else setImmediate(run);
});

// ================== 排程（Asia/Taipei） ==================
cron.schedule("40 7 * * 1-5", async () => {
  try {
    await notifyStocks(
`【盤前導航｜07:40】
• 大盤五重點（國際盤/新聞/技術/籌碼/氛圍）
• 三大法人籌碼（前日）
• 投顧重點（ClipBox-昨晚～今晨）
• 今日策略與觀察股
（註：投顧重點來自你轉貼的 ClipBox）`);
  } catch (e) { console.error("07:40 push error", e); }
}, { timezone: "Asia/Taipei" });

cron.schedule("55 8 * * 1-5", async () => {
  try {
    await notifyStocks(
`【開盤補充｜08:55】
• 集合競價關鍵訊號
• 早盤委託量異常股
• 法人掛單/撤單異動
• 短線預警（若有 ClipBox 盤前來文會引用）`);
  } catch (e) { console.error("08:55 push error", e); }
}, { timezone: "Asia/Taipei" });

cron.schedule("0 16 * * 1-5", async () => {
  try { await notifyCore("【提醒】收盤囉～要不要記今天的戀股日誌？（回覆 /日誌完成）"); }
  catch (e) { console.error("16:00 reminder error", e); }
}, { timezone: "Asia/Taipei" });

cron.schedule("30 16 * * 1-5", async () => {
  try { await notifyStocks("【收盤彙整｜16:30】你的追蹤股收盤整理與 ClipBox 今日重點（示意版）。"); }
  catch (e) { console.error("16:30 push error", e); }
}, { timezone: "Asia/Taipei" });

cron.schedule("45 16 * * 1-5", async () => {
  try { await notifyStocks("【補抓｜16:45】若稍早資料延遲，這裡補送（示意版）。"); }
  catch (e) { console.error("16:45 push error", e); }
}, { timezone: "Asia/Taipei" });

cron.schedule("30 21 * * *", async () => {
  try { if (state.washReminderOn) await notifyCore("【提醒】該去洗澡囉 🛁"); } 
  catch (e) { console.error("21:30 wash error", e); }
}, { timezone: "Asia/Taipei" });

cron.schedule("0 23 * * *", async () => {
  try { if (state.sleepReminderOn) await notifyCore("【提醒】差不多該睡覺啦 😴"); }
  catch (e) { console.error("23:00 sleep error", e); }
}, { timezone: "Asia/Taipei" });

cron.schedule("30 7 * * *", async () => {
  try {
    const y = dayjs().subtract(1, "day").format("YYYY-MM-DD");
    if (state.lastJournalDoneDate === y) return;
    await notifyCore(`【補提醒｜07:30】你昨天（${y}）的戀股日誌還沒完成喔～要補一下嗎？（/日誌完成）`);
  } catch (e) { console.error("07:30 backfill error", e); }
}, { timezone: "Asia/Taipei" });

const app2 = app; // 防止未使用警告（部分平台）

// 標記日誌完成（可由外部打）
app.post("/journal-done", (req, res) => {
  state.lastJournalDoneDate = dayjs().format("YYYY-MM-DD");
  res.json({ ok: true, done: state.lastJournalDoneDate });
});

// ================== 啟動 ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ webhook server listening on ${PORT}`);
});
