// CommonJS；Node 18 內建 fetch
const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

// ---- Day.js：固定台北時區 ----
dayjsBase.extend(utc);
dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

// ---- ENV（Render 可覆蓋；請在 Environment 設定無引號值）----
const TOKEN    = (process.env.BOT_TOKEN || "8279562243:AAEyhzGPAy7FeK-TvJQAbwhAPVLHXG_z2gY").trim().replace(/^"+|"+$/g,"");
const CHAT_ID  = (process.env.CHAT_ID   || "8418229161").trim().replace(/^"+|"+$/g,"");
const PING_KEY = (process.env.PING_KEY  || "dev-only").trim();
const TG_API   = `https://api.telegram.org/bot${TOKEN}`;

const app = express();
app.use(express.json());

// ---- 發送工具 ----
async function send(chatId, text, extra = {}) {
  const url = `${TG_API}/sendMessage`;
  const body = { chat_id: chatId, text, ...extra };
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let j = {}; try { j = await res.json(); } catch {}
  if (!j.ok) { console.error("send() failed:", j, text); }
  return j;
}

// ---- 狀態（僅 auto / work）----
const state = {
  mode: "auto",                 // auto | work
  lastJournalDoneDate: null,    // YYYY-MM-DD
  journalAuto: true             // 16:00 是否自動送草稿
};
// 生活提醒開關
const flags = { bathReminder: true, sleepReminder: true };

// ---- 追蹤清單（預放你目前的清單；可用指令增刪）----
const watchlist = new Set(["2355","2374","1815","5314","2438","2382","2027"]);

// ---- 快取：名稱（24h）與 OHLC（10分鐘）----
const ohlcCache = new Map(); // key: `${code}@${rocDate}`
function cacheKey(code, roc) { return `${code}@${roc}`; }

// ---- 小工具 ----
function toNum(x){ if(x==null) return NaN; const n=Number(String(x).replace(/,/g,"").trim()); return Number.isFinite(n)?n:NaN; }
function toRoc(d, withDay=false){ const y=d.year()-1911, mm=d.format("MM"); return withDay?`${y}/${mm}/${d.format("DD")}`:`${y}/${mm}`; }
const isWeekday=(d=dayjs())=>{const w=d.day(); return w>=1&&w<=5;};
const isWeekend=(d=dayjs())=>!isWeekday(d);

// ---- 名稱→代號（TWSE codeQuery；模糊查）----
async function resolveCodeOrName(input){
  const v=(input||"").trim();
  if(/^\d{4}$/.test(v)) return v;
  const url=`https://www.twse.com.tw/zh/api/codeQuery?query=${encodeURIComponent(v)}`;
  const r=await fetch(url,{headers:{"Accept":"application/json"}});
  if(!r.ok) return null;
  const j=await r.json().catch(()=>null);
  const arr=Array.isArray(j?.suggestion)?j.suggestion:[];
  const items=arr.filter(s=>typeof s==="string"&&s.includes("\t")).map(s=>{
    const [code,name]=s.split("\t"); return {code,name};
  });
  const hit=items.find(it=>it.name.includes(v))||items[0];
  return hit?.code||null;
}
async function listCandidates(keyword,limit=6){
  const url=`https://www.twse.com.tw/zh/api/codeQuery?query=${encodeURIComponent(keyword)}`;
  const r=await fetch(url,{headers:{"Accept":"application/json"}});
  if(!r.ok) return [];
  const j=await r.json().catch(()=>null);
  const arr=Array.isArray(j?.suggestion)?j.suggestion:[];
  return arr.filter(s=>typeof s==="string"&&s.includes("\t")).slice(0,limit)
            .map(s=>{const [code,name]=s.split("\t"); return {code,name};});
}

// ---- TWSE：最近一筆（日收；跨月回退）----
async function fetchTWSELastOHLC(code){
  const tryMonths=[dayjs().startOf("month"), dayjs().subtract(1,"month").startOf("month")];
  for(const m of tryMonths){
    const yyyymm01=m.format("YYYYMM01");
    const url=`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${yyyymm01}&stockNo=${code}`;
    const r=await fetch(url,{headers:{"Accept":"application/json"}});
    if(!r.ok) continue;
    const j=await r.json().catch(()=>({}));
    if(j?.stat!=="OK"||!Array.isArray(j?.data)) continue;
    for(let i=j.data.length-1;i>=0;i--){
      const row=j.data[i]; if(!row||row.length<9) continue;
      const [dateROC,, , open, high, low, close]=row;
      const o=toNum(open), h=toNum(high), l=toNum(low), c=toNum(close);
      if([o,h,l,c].every(Number.isFinite)) return {code,date:dateROC,open:o,high:h,low:l,close:c,src:"TWSE"};
    }
  }
  throw new Error("TWSE 無可用資料");
}

// ---- TPEx：最近一筆（日收；逐日回退 ≤7天）----
async function fetchTPExLastOHLC(code){
  for(let k=0;k<7;k++){
    const d=dayjs().subtract(k,"day"); const roc=toRoc(d,true);
    const url=`https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes?d=${encodeURIComponent(roc)}`;
    const r=await fetch(url,{headers:{"Accept":"application/json"}});
    if(!r.ok) continue;
    const arr=await r.json().catch(()=>null);
    if(!Array.isArray(arr)||arr.length===0) continue;
    const rec=arr.find(x=>x?.Code===code||x?.SecuritiesCode===code||x?.股票代號===code||x?.證券代號===code);
    if(!rec) continue;
    const o=toNum(rec.Open||rec.開盤||rec.開盤價);
    const h=toNum(rec.High||rec.最高||rec.最高價);
    const l=toNum(rec.Low ||rec.最低||rec.最低價);
    const c=toNum(rec.Close||rec.收盤||rec.收盤價);
    if([o,h,l,c].every(Number.isFinite)) return {code,date:roc,open:o,high:h,low:l,close:c,src:"TPEx"};
  }
  throw new Error("TPEx 無可用資料");
}

// ---- 查價（含 10 分鐘快取）----
async function fetchLastOHLC(code){
  if(!/^\d{4}$/.test(code)) throw new Error("請輸入 4 碼股票代號");
  const todayKey=cacheKey(code,toRoc(dayjs(),true));
  const hit=ohlcCache.get(todayKey);
  const now=Date.now();
  if(hit&&hit.expires>now) return hit.obj;
  let obj; try{ obj=await fetchTWSELastOHLC(code); } catch { obj=await fetchTPExLastOHLC(code); }
  const key=cacheKey(code,obj.date);
  ohlcCache.set(key,{obj,expires:now+10*60*1000});
  return obj;
}

// ---- 日誌草稿 ----
async function buildJournalDraft(){
  const today=dayjs().format("YYYY/MM/DD");
  const wl=[...watchlist];
  const lines=[];
  if(wl.length===0){
    lines.push("（目前追蹤清單為空，先用 /追蹤新增 2330 加幾檔吧）");
  }else{
    for(const code of wl){
      try{
        const q=await fetchLastOHLC(code);
        lines.push(`• ${code} 收 ${q.close}（開:${q.open} 高:${q.high} 低:${q.low}｜${q.src} ${q.date}）`);
      }catch{ lines.push(`• ${code}（尚未取得當日資料或不支援）`); }
    }
  }
  return (
`【今日日誌草稿｜${today}】
◇ 大盤（模板句）：區間震盪；電子偏強、傳產回檔；量能中性。
◇ 追蹤清單：
${lines.join("\n")}
—
〔請填〕今日心得（2–3 行）：__
〔請填〕明日計畫（1–3 點）：__／__／__
（填完回覆 /日誌完成）`);
}

// ---- 指令鍵盤 ----
const MENU_KEYBOARD={ reply_markup:{ keyboard:[[{text:"/上班"},{text:"/自動"}],[{text:"/日誌完成"},{text:"/狀態"}]], resize_keyboard:true, one_time_keyboard:false } };

// ---- 指令處理 ----
async function handleCommand(chatId, text){
  if(text==="/start"||text==="/menu"){
    return send(chatId,
`指令：
/上班  只推重要訊息（08:00-17:00）
/自動  自動判斷平/假日
/日誌完成  標記今日完成
/狀態  檢視目前設定
/股價 代號或名稱   例：/股價 2330、/股價 台積電
/查代號 關鍵字     例：/查代號 聯發
/追蹤新增 代號     /追蹤移除 代號
/清單               顯示追蹤清單
/追蹤收盤           立即查清單收盤
/洗澡提醒開啟|關閉  /睡覺提醒開啟|關閉`, MENU_KEYBOARD);
  }

  if(text==="/下班"||text==="/假日"){ state.mode="auto"; return send(chatId,"「下班／假日」模式已取消，已改用：自動模式 ✅",MENU_KEYBOARD); }
  if(text==="/上班"){ state.mode="work"; return send(chatId,"已切換：上班模式 ✅",MENU_KEYBOARD); }
  if(text==="/自動"){ state.mode="auto"; return send(chatId,"已切換：自動模式 ✅",MENU_KEYBOARD); }

  if(text==="/日誌完成"){
    state.lastJournalDoneDate=dayjs().format("YYYY-MM-DD");
    return send(chatId,`已標記今日日誌完成（${state.lastJournalDoneDate}）👍`);
  }
  if(text==="/日誌模板"){
    const tpl=
`【今日日誌｜${dayjs().format("YYYY/MM/DD")}】
1) 心情指數（1–5）：__
2) 今日三重點：
• __
• __
• __
3) 操作檢討：__
4) 明日計畫（關鍵價位/條件）：
• __
• __
• __
5) 風險與備註：__`;
    return send(chatId,tpl);
  }
  if(text==="/日誌略過今天"){ state.lastJournalDoneDate=dayjs().format("YYYY-MM-DD"); return send(chatId,"OK，今日日誌略過；明早不再補提醒。"); }

  if(text==="/狀態"){
    return send(chatId,
`模式：${state.mode}
台北時間：${dayjs().format("YYYY-MM-DD HH:mm")}
盤前導航：07:40（平日）
開盤補充：08:55（平日）
日誌草稿：16:00（平日，自動：${state.journalAuto?"✅":"⛔"}）
收盤彙整：16:30（平日；16:45 補抓）
週末日誌：21:00
隔日補查：07:30
追蹤清單：${[...watchlist].join(", ")||"（空）"}
洗澡提醒：${flags.bathReminder?"✅ 開":"⛔ 關"}；就寢提醒：${flags.sleepReminder?"✅ 開":"⛔ 關"}`, MENU_KEYBOARD);
  }

  // 生活提醒開關
  if(text==="/洗澡提醒開啟"){ flags.bathReminder=true; return send(chatId,"已開啟：21:30 洗澡提醒 🛁"); }
  if(text==="/洗澡提醒關閉"){ flags.bathReminder=false; return send(chatId,"已關閉：21:30 洗澡提醒"); }
  if(text==="/睡覺提醒開啟"){ flags.sleepReminder=true; return send(chatId,"已開啟：23:00 就寢提醒 😴"); }
  if(text==="/睡覺提醒關閉"){ flags.sleepReminder=false; return send(chatId,"已關閉：23:00 就寢提醒"); }

  // 名稱→代號候選
  if(text.startsWith("/查代號")){
    const kw=text.replace("/查代號","").trim();
    if(!kw) return send(chatId,"請在後面加關鍵字，例如：/查代號 台積");
    const cands=await listCandidates(kw,6);
    if(cands.length===0) return send(chatId,`找不到與「${kw}」相關的代號。`);
    const lines=cands.map(x=>`• ${x.code} ${x.name}`);
    return send(chatId,`候選清單：\n${lines.join("\n")}\n\n可直接輸入：/股價 代號`);
  }

  // 股價（代號或名稱）
  if(text.startsWith("/股價")){
    const q=text.replace("/股價","").trim();
    if(!q) return send(chatId,"用法：/股價 2330 或 /股價 台積電");
    const code=await resolveCodeOrName(q);
    if(!code) return send(chatId,`找不到「${q}」對應的代號。`);
    try{
      const r=await fetchLastOHLC(code);
      return send(chatId,`【${r.code}｜${r.src}】${r.date} 收：${r.close}（開:${r.open} 高:${r.high} 低:${r.low}）`);
    }catch(e){
      return send(chatId,`查不到 ${code} 的日收資料，或今日尚未更新。稍晚再試。`);
    }
  }

  // 追蹤清單
  if(text.startsWith("/追蹤新增")){
    const arg=(text.split(/\s+/)[1]||"").trim();
    if(!arg) return send(chatId,"用法：/追蹤新增 代號或名稱");
    const code=await resolveCodeOrName(arg); if(!code) return send(chatId,`無法辨識：「${arg}」`);
    watchlist.add(code);
    return send(chatId,`已加入追蹤：${code}（目前清單：${[...watchlist].join(", ")||"無"}）`);
  }
  if(text.startsWith("/追蹤移除")){
    const arg=(text.split(/\s+/)[1]||"").trim();
    if(!arg) return send(chatId,"用法：/追蹤移除 代號或名稱");
    const code=await resolveCodeOrName(arg); if(!code) return send(chatId,`無法辨識：「${arg}」`);
    watchlist.delete(code);
    return send(chatId,`已移除追蹤：${code}（目前清單：${[...watchlist].join(", ")||"無"}）`);
  }
  if(text==="/清單"){
    return send(chatId,`追蹤清單：${[...watchlist].join(", ")||"（空）"}`);
  }
  if(text==="/追蹤收盤"){
    if(watchlist.size===0) return send(chatId,"清單為空，先用 /追蹤新增 2330 加幾檔吧。");
    const lines=[];
    for(const code of [...watchlist]){
      try{ const q=await fetchLastOHLC(code); lines.push(`${code} 收盤 ${q.close}`); }
      catch{ lines.push(`${code}（抓取失敗或不支援）`); }
    }
    return send(chatId,`【追蹤清單｜收盤】\n`+lines.join("\n"));
  }

  return send(chatId,"看不懂這個指令耶～輸入 /menu 看看可以做什麼吧！", MENU_KEYBOARD);
}

// ---- 健康檢查／首頁 ----
app.get("/",(_req,res)=>res.send({ok:true,service:"orbit07-webhook",now_taipei:dayjs().format("YYYY-MM-DD HH:mm:ss")}));
app.get("/health",(_req,res)=>res.json({ok:true,service:"orbit07-webhook",now_taipei:dayjs().format("YYYY-MM-DD HH:mm:ss")}));

// ---- /ping：需帶 key ----
app.get("/ping", async (req,res)=>{
  const key=String(req.query.key||""); const t=String(req.query.text||"Ping ✅");
  if(key!==PING_KEY) return res.status(401).json({ok:false,msg:"unauthorized"});
  try{ const j=await send(CHAT_ID,t); res.json({ok:true,result:j}); }
  catch(e){ console.error("ping error:",e); res.status(500).json({ok:false,msg:"ping failed"}); }
});

// ---- /webhook：回 200，再非同步處理 ----
app.post("/webhook",(req,res)=>{
  res.sendStatus(200);
  const run=async()=>{
    try{
      const u=req.body; console.log("TG update:", JSON.stringify(u));
      const msg=u.message||u.edited_message||u.channel_post||u.edited_channel_post;
      if(!msg) return;
      const chatId=String(msg.chat?.id||"");
      const text=(msg.text||msg.caption||"").trim();
      if(!chatId) return;
      if(text.startsWith("/")) await handleCommand(chatId,text);
      // 非指令：不自動回，以免洗版
    }catch(e){ console.error("webhook handler error:",e); }
  };
  if(typeof queueMicrotask==="function") queueMicrotask(run); else setImmediate(run);
});

// ---- 既有排程（Asia/Taipei）----
// 07:40：盤前導航（平日）
cron.schedule("40 7 * * 1-5", async ()=>{ try{
  if(!isWeekday()) return;
  await send(CHAT_ID,
`【盤前導航｜07:40】
• 大盤五重點（國際盤/新聞/技術/籌碼/氛圍）
• 三大法人籌碼（前日）
• 投顧早報（已出稿者）
• 今日策略與觀察股
• 盤前注意事項
（備註：之後接自動數據；目前為模板）`);
}catch(e){ console.error("07:40 push error",e);} }, {timezone:"Asia/Taipei"});

// 08:55：開盤補充（平日）
cron.schedule("55 8 * * 1-5", async ()=>{ try{
  if(!isWeekday()) return;
  await send(CHAT_ID,
`【開盤補充｜08:55】
• 集合競價關鍵訊號
• 早盤委託量異常股
• 法人掛單/撤單異動
• 短線預警
（備註：之後接即時來源；目前為模板）`);
}catch(e){ console.error("08:55 push error",e);} }, {timezone:"Asia/Taipei"});

// 16:00：日誌草稿（平日）
cron.schedule("0 16 * * 1-5", async ()=>{ try{
  if(!isWeekday()) return;
  if(!state.journalAuto) return;
  const draft=await buildJournalDraft();
  await send(CHAT_ID,draft);
}catch(e){ console.error("16:00 journal draft error",e);} }, {timezone:"Asia/Taipei"});

// 16:30：追蹤清單收盤彙整（平日）
cron.schedule("30 16 * * 1-5", async ()=>{ try{
  if(!isWeekday()) return;
  if(watchlist.size===0) return;
  const lines=[];
  for(const code of [...watchlist]){
    try{ const q=await fetchLastOHLC(code); lines.push(`${code} 收盤 ${q.close}`); }
    catch{ lines.push(`${code}（抓取失敗或不支援）`); }
  }
  await send(CHAT_ID,`【追蹤清單｜收盤】\n`+lines.join("\n"));
}catch(e){ console.error("16:30 watchlist push error",e);} }, {timezone:"Asia/Taipei"});

// 16:45：補抓（若 16:30 尚非當日或抓失敗時補發）
cron.schedule("45 16 * * 1-5", async ()=>{ try{
  if(!isWeekday()) return;
  if(watchlist.size===0) return;
  const todayRoc=toRoc(dayjs(),true);
  let need=false; const lines=[];
  for(const code of [...watchlist]){
    try{ const q=await fetchLastOHLC(code); if(q.date!==todayRoc) need=true; lines.push(`${code} 收盤 ${q.close}（${q.date}）`); }
    catch{ need=true; lines.push(`${code}（抓取失敗或不支援）`); }
  }
  if(need) await send(CHAT_ID,`【追蹤清單｜補發】\n`+lines.join("\n"));
}catch(e){ console.error("16:45 supplement error",e);} }, {timezone:"Asia/Taipei"});

// 21:00：週末日誌提醒
cron.schedule("0 21 * * 6,0", async ()=>{ try{
  if(!isWeekend()) return;
  await send(CHAT_ID,"【提醒】今晚要不要補本週的戀股日誌與策略？（/日誌完成）");
}catch(e){ console.error("21:00 weekend reminder error",e);} }, {timezone:"Asia/Taipei"});

// 21:30 / 23:00：生活提醒（每日）
cron.schedule("30 21 * * *", async ()=>{ try{
  if(!flags.bathReminder) return;
  await send(CHAT_ID,"【提醒】21:30 到囉～該去洗澡了🛁");
}catch(e){ console.error("21:30 bath reminder error",e);} }, {timezone:"Asia/Taipei"});
cron.schedule("0 23 * * *", async ()=>{ try{
  if(!flags.sleepReminder) return;
  await send(CHAT_ID,"【提醒】23:00～上床睡覺時間到啦😴 早睡明天更有精神！");
}catch(e){ console.error("23:00 sleep reminder error",e);} }, {timezone:"Asia/Taipei"});

// 07:30：隔日補檢查（昨日未完成）
cron.schedule("30 7 * * *", async ()=>{ try{
  const y=dayjs().subtract(1,"day").format("YYYY-MM-DD");
  if(state.lastJournalDoneDate===y) return;
  await send(CHAT_ID,`【補提醒｜07:30】你昨天（${y}）的戀股日誌還沒完成喔～要補一下嗎？（/日誌完成）`);
}catch(e){ console.error("07:30 backfill error",e);} }, {timezone:"Asia/Taipei"});

// ---- 啟動服務 ----
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`✅ webhook server listening on ${PORT}`));
