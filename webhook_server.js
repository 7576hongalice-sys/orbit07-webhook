// webhook_server.js — ORBIT-07（全開＋隱藏張數版）
// Node 18 內建 fetch；Express webhook + Taipei cron + Telegram Bot
const express = require("express");
const cron = require("node-cron");
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjsBase.extend(utc); dayjsBase.extend(timezone);
const dayjs = (d)=>dayjsBase.tz(d, "Asia/Taipei");

// ===== 憑證（環境變數優先；以下為你的預設值）=====
const TOKEN   = process.env.BOT_TOKEN || "8279562243:AAEyhzGPAy7FeK-TvJQAbwhAPVLHXG_z2gY";
const CHAT_ID = process.env.CHAT_ID   || "8418229161";
const TG_API  = `https://api.telegram.org/bot${TOKEN}`;

const app = express();
app.use(express.json());

// ===== TG 基本工具 =====
async function tg(method, payload){
  const res = await fetch(`${TG_API}/${method}`,{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  return res.json();
}
async function send(chatId, text, extra={}){
  const j = await tg("sendMessage", { chat_id: chatId, text, parse_mode:"HTML", ...extra });
  if(!j.ok) console.error("sendMessage failed:", j);
  return j;
}
async function edit(chatId, msgId, text, extra={}){
  const j = await tg("editMessageText", { chat_id: chatId, message_id: msgId, text, parse_mode:"HTML", ...extra });
  if(!j.ok) console.error("editMessageText failed:", j);
  return j;
}

// ===== 小工具 =====
const isWeekday = (d=dayjs()) => { const w=d.day(); return w>=1 && w<=5; };
const isWeekend = (d=dayjs()) => !isWeekday(d);
const todayKey = ()=> dayjs().format("YYYY-MM-DD");

// ===== 名稱 ↔ 代號（別名表：可再擴）=====
const NAME_ALIASES = {
  // 你的清單
  "長榮航":"2618","南仁湖":"5905","力新":"5202","玉山金":"2884","佳能":"2374","敬鵬":"2355",
  "富喬":"1815","世紀":"5314","翔耀":"2438","廣達":"2382","大成鋼":"2027",
  "00687B":"00687B","00937B":"00937B",
  // 常見
  "台積電":"2330","臺積電":"2330","TSMC":"2330","鴻海":"2317","聯發科":"2454","台達電":"2308","聯電":"2303",
  "中鋼":"2002","富邦金":"2881","國泰金":"2882","長榮":"2603","陽明":"2609","萬海":"2615",
  "華航":"2610","友達":"2409","群創":"3481","緯創":"3231","技嘉":"2376"
};
const CODE_TO_NAME = {
  "2618":"長榮航","5905":"南仁湖","5202":"力新","2884":"玉山金","2374":"佳能","2355":"敬鵬",
  "1815":"富喬","5314":"世紀","2438":"翔耀","2382":"廣達","2027":"大成鋼",
  "00687B":"國泰20年美債","00937B":"群益ESG投等債20+",
  "2330":"台積電","2317":"鴻海","2454":"聯發科","2308":"台達電","2303":"聯電",
  "2002":"中鋼","2881":"富邦金","2882":"國泰金","2603":"長榮","2609":"陽明","2615":"萬海",
  "2610":"華航","2409":"友達","3481":"群創","3231":"緯創","2376":"技嘉"
};
const normalizeName = s => (s||"").trim().replace(/\s+/g,"").replace(/台/g,"臺").toUpperCase();
function resolveToCode(input){
  if(!input) return null;
  const raw=String(input).trim();
  if(/^\d{4,5}[A-Z]?$/i.test(raw)) return raw.toUpperCase();
  const norm=normalizeName(raw);
  if(NAME_ALIASES[norm]) return NAME_ALIASES[norm];
  for(const [name,code] of Object.entries(NAME_ALIASES)){
    const nn=normalizeName(name);
    if(nn.includes(norm)||norm.includes(nn)) return code;
  }
  return null;
}
function showCodeName(code){ const nm = CODE_TO_NAME[code]||""; return nm?`${code} ${nm}`:`${code}`; }

// ===== 抓價（TWSE/TPEx 月表）=====
async function fetchTwseMonthly(code, anyDay=new Date()){
  const y=dayjs(anyDay).format("YYYY"); const m=dayjs(anyDay).format("MM");
  const url=`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${y}${m}01&stockNo=${code}`;
  const r=await fetch(url,{headers:{Accept:"application/json"}});
  if(!r.ok) return null; const j=await r.json().catch(()=>null);
  if(!j||j.stat!=="OK"||!Array.isArray(j.data)) return null;
  const rows=j.data.map(row=>{
    const [d,, ,o,h,l,c]=row; const n=v=>Number(String(v).replace(/[,--]/g,""));
    return { date:d, open:n(o), high:n(h), low:n(l), close:n(c) };
  }).filter(x=>isFinite(x.close)&&x.close>0);
  if(!rows.length) return null;
  const last=rows[rows.length-1], prev=rows[rows.length-2]||null;
  return { ...last, prevClose: prev?prev.close:null, source:"TWSE" };
}
async function fetchTpexMonthly(code, anyDay=new Date()){
  const rocY=(dayjs(anyDay).year()-1911).toString(); const mm=dayjs(anyDay).format("MM");
  const url=`https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=${rocY}/${mm}&stkno=${code}`;
  const r=await fetch(url,{headers:{Accept:"application/json"}});
  if(!r.ok) return null; const j=await r.json().catch(()=>null);
  const arr=j?.aaData||j?.data||[]; if(!Array.isArray(arr)||!arr.length) return null;
  const parse=row=>{
    const n=v=>Number(String(v||"").replace(/[,--]/g,""));
    return { date:String(row[0]||"").trim(), open:n(row[3]), high:n(row[4]), low:n(row[5]), close:n(row[6]) };
  };
  const rows=arr.map(parse).filter(x=>isFinite(x.close)&&x.close>0);
  if(!rows.length) return null;
  const last=rows[rows.length-1], prev=rows[rows.length-2]||null;
  return { ...last, prevClose: prev?prev.close:null, source:"TPEx" };
}
async function getDailyOHLC(code){
  return (await fetchTwseMonthly(code)) || (await fetchTpexMonthly(code)) || null;
}
async function getBatchQuotes(codes){
  const out={};
  for(const c of codes){
    try{
      const q=await getDailyOHLC(c);
      if(q){
        const chgPct = (q.prevClose && q.prevClose>0) ? ((q.close - q.prevClose)/q.prevClose*100) : null;
        out[c]={ close:q.close, date:q.date, chgPct, source:q.source, open:q.open, high:q.high, low:q.low };
      }else out[c]=null;
    }catch{ out[c]=null; }
  }
  return out;
}

// ===== 使用者狀態／資料（張數不顯示，但可儲存）=====
const state = {
  // 模式與提醒
  mode:"auto", bathOn:true, sleepOn:true,
  // 盤中即時（A 模式）
  immediateOn:true, cooldownMin:5,
  // 清單
  watch:new Set(["2355","2374","1815","5314","2438","2382","2027"]),
  hold:{ "2618":{}, "5905":{}, "5202":{}, "2884":{}, "00687B":{}, "00937B":{} },
  // Clip 資料（每日）
  clips:{},
  // 冷卻彙整
  burst:{ timer:null, items:[] }
};
function clipsToday(){ const k=todayKey(); state.clips[k]=state.clips[k]||[]; return state.clips[k]; }

// ===== Clip 偵測 =====
function extractUrls(text){ if(!text) return []; const m=text.match(/https?:\/\/\S+/g); return m||[]; }
function detectPlatform(text){
  const s=(text||"").toLowerCase();
  if(/facebook\.com|fb\.me/.test(s)) return "FB";
  if(/line\.me|liff\./.test(s)) return "LINE";
  if(/t\.me|telegram\.org/.test(s)) return "TG";
  if(/https?:\/\//.test(s)) return "Web";
  return "未知";
}
function detectCodes(text){
  const found=new Set();
  (text.match(/\b\d{4}\b/g)||[]).forEach(c=>found.add(c));
  const norm=normalizeName(text);
  for(const [name,code] of Object.entries(NAME_ALIASES)){
    const nn=normalizeName(name);
    if(norm.includes(nn)) found.add(code);
  }
  return Array.from(found);
}
function markHits(codes){
  return codes.map(c=>{
    const hit = state.watch.has(c) || !!state.hold[c];
    return hit? `${showCodeName(c)}✅` : showCodeName(c);
  }).join("、");
}
function pushClipFromMessage(msg){
  const text=(msg.text||msg.caption||"").trim();
  const urls=extractUrls(text);
  const platform=detectPlatform(text);
  const codes=detectCodes(text);
  const kind = msg.photo ? "圖片" : (urls.length?"連結":"文字");
  clipsToday().push({ t: Date.now(), kind, platform, text, urls, codes });
  return { platform, codes, text, kind };
}

// ===== 常駐鍵盤 =====
async function tgReplyKeyboard(chatId){
  const keyboard = [
    [{text:"查價"},{text:"清單"},{text:"clip 摘要 今日"}],
    [{text:"狀態"},{text:"上班"},{text:"自動"}],
  ];
  return send(chatId,"功能列就緒。查價可輸入「股價 2330／查 佳能」。",{
    reply_markup:{ keyboard, resize_keyboard:true, is_persistent:true }
  });
}

// ===== 內嵌按鈕（清單用）=====
function inlineRowFor(code, listType){
  return { inline_keyboard: [[
    { text:"查價", callback_data:`PRICE:${code}` },
    { text:"移除", callback_data:`REMOVE:${listType}:${code}` },
    ...(listType==="hold" ? [{ text:"設成本", callback_data:`SETCOST:${code}` }] : [])
  ]]};
}

// ===== 清單（排序／篩選／匯出）=====
function parseListArgs(text){
  const t = text.trim();
  const opt = { type:"all", sortBy:null, sortDir:"desc", filter:null, export:null };
  if(/清單\s+追蹤/.test(t)) opt.type="watch";
  if(/清單\s+持股/.test(t)) opt.type="hold";
  const mSort = t.match(/排序\s+([^\s]+)(?:\s+(由低到高|由高到低))?/);
  if(mSort){
    const f=mSort[1]; opt.sortBy=/收盤|close/i.test(f)?"close":/盈虧|pnl/i.test(f)?"pnl":"chg";
    opt.sortDir = mSort[2]==="由低到高" ? "asc" : "desc";
  }
  const mFilter = t.match(/篩選\s+(.+)/);
  if(mFilter){
    const s=mFilter[1].replace(/\s+/g,""); let field="漲跌%", body=s;
    const mField=s.match(/^(漲跌%|收盤|盈虧%)([<>=].+)$/); if(mField){ field=mField[1]; body=mField[2]; }
    const m=body.match(/^(>=|<=|>|<|=)(-?\d+(?:\.\d+)?)%?$/);
    if(m) opt.filter={ field, op:m[1], value:m[2] };
  }
  const mExport = t.match(/匯出\s*(文字|CSV)?/i);
  if(mExport) opt.export=(mExport[1]||"文字").toUpperCase();
  return opt;
}
async function showList(chatId, options={}){
  const type=options.type||"all", sortBy=options.sortBy||null, sortDir=options.sortDir||"desc", filter=options.filter||null;
  let items=[];
  if(type==="all"||type==="hold"){ for(const c of Object.keys(state.hold)) items.push({code:c, kind:"hold"}); }
  if(type==="all"||type==="watch"){ for(const c of Array.from(state.watch)) if(!state.hold[c]) items.push({code:c, kind:"watch"}); }
  const codes=items.map(i=>i.code);
  const quotes=await getBatchQuotes(codes);
  const rows=items.map(it=>{
    const q=quotes[it.code]; const close=q?.close??null; const chgPct=q?.chgPct??null;
    const cost=state.hold[it.code]?.cost??null;
    const pnlPct=(cost&&close)? ((close-cost)/cost*100):null; // 張數不使用
    return { ...it, close, chgPct, pnlPct };
  });
  const num=v=> typeof v==="number"?v : (v==null?null:Number(String(v).replace(/%/g,"")));
  const byF=(r,f)=> f==="漲跌%"||f==="chg"? r.chgPct : f==="收盤"||f==="close"? r.close : f==="盈虧%"||f==="pnl"? r.pnlPct : null;
  let arr=rows;
  if(filter){
    const {field,op,value}=filter; const val=num(value);
    arr=rows.filter(r=>{ const x=byF(r,field); if(x==null||val==null) return false;
      return op==">"?x>val: op==">="?x>=val: op=="<"?x<val: op=="<="?x<=val: Math.abs(x-val)<1e-9; });
  }
  if(sortBy){
    const key=r=> sortBy==="chg"? (r.chgPct ?? -9e9) : sortBy==="close"? (r.close ?? -9e9) : (r.pnlPct ?? -9e9);
    arr.sort((a,b)=> sortDir==="asc"? key(a)-key(b) : key(b)-key(a));
  }
  const tag = type==="watch"?"追蹤": type==="hold"?"持股":"全部";
  const sortTag = sortBy ? `｜排序：${sortBy==="chg"?"漲跌%":sortBy==="close"?"收盤":"盈虧%"} ${sortDir==="asc"?"低→高":"高→低"}` : "";
  const filterTag = filter ? `｜篩選：${filter.field}${filter.op}${filter.value}` : "";
  const head = `【你的清單｜${tag}${sortTag}${filterTag}】`;
  if(arr.length===0) return send(chatId, `${head}\n（沒有符合條件的標的）`);
  await send(chatId, head);
  const max=Math.min(arr.length,20);
  for(let i=0;i<max;i++){
    const r=arr[i]; const name=showCodeName(r.code);
    const chgTxt = (r.chgPct==null)?"—":`${(r.chgPct>=0?"+":"")}${r.chgPct.toFixed(2)}%`;
    const priceTxt=(r.close==null)?"—":r.close.toFixed(2);
    const pnlTxt=(r.pnlPct==null)?"":`｜盈虧 ${(r.pnlPct>=0?"+":"")}${r.pnlPct.toFixed(2)}%`;
    const line=`${i+1}) ${name}　收 ${priceTxt}（${chgTxt}）${pnlTxt}`;
    await send(chatId, line, { reply_markup: inlineRowFor(r.code, r.kind) });
  }
  if(arr.length>max) await send(chatId, `其餘 ${arr.length-max} 檔略。你可用「清單 追蹤」或排序／篩選縮小範圍。`);
}

// ===== A 模式：盤中即時（含冷卻彙整）=====
function inWorkHours(){
  const h=Number(dayjs().format("H")); const w=isWeekday();
  return w && h>=8 && h<17;
}
function scheduleBurstSend(chatId){
  if(state.burst.timer) return;
  state.burst.timer = setTimeout(async ()=>{
    try{
      const items = state.burst.items.splice(0);
      state.burst.timer=null;
      if(!items.length) return;
      const n=items.length;
      const symSet=new Set(); items.forEach(it=> it.codes.forEach(c=>symSet.add(c)));
      const syms=Array.from(symSet).slice(0,12).map(c=>showCodeName(c)).join("、") || "—";
      const platforms={}; items.forEach(it=> platforms[it.platform]=(platforms[it.platform]||0)+1);
      const pfTxt = Object.entries(platforms).map(([k,v])=>`${k} ${v}`).join("、");
      await send(chatId, `【即時彙整｜${dayjs().format("MM/DD HH:mm")}】共 ${n} 則（${pfTxt}）\n標的：${syms}`);
    }catch(e){ console.error("burst send error:",e); }
  }, Math.max(0, state.cooldownMin)*60*1000);
}
async function pushImmediateCard(chatId, meta){
  const title = `【即時解析】${meta.platform}｜${dayjs().format("YYYY-MM-DD HH:mm")}`;
  const codesTxt = meta.codes.length? `標的：${markHits(meta.codes)}` : "標的：—";
  const snippet = meta.text ? meta.text.replace(/\s+/g," ").slice(0,60) : "（非文字訊息）";
  const body = `${title}\n${codesTxt}\n摘錄：${snippet}`;
  await send(chatId, body);
}
function handleImmediateFlow(chatId, meta){
  state.burst.items.push({ codes:meta.codes, platform:meta.platform });
  scheduleBurstSend(chatId);
  if(!state.immediateOn) return;
  if(inWorkHours()){ // 上班：回精簡
    const hit = meta.codes.length? `標的：${markHits(meta.codes)}` : "標的：—";
    send(chatId, `【即時解析｜精簡】${hit}`);
    return;
  }
  // 非上班：完整卡
  pushImmediateCard(chatId, meta);
}

// ===== C 模式：今日 clip 摘要 =====
async function showClipSummaryToday(chatId){
  const arr = clipsToday();
  if(!arr.length) return send(chatId, `【今日 clip 摘要｜${dayjs().format("MM/DD")}】尚未收到任何 clip，轉一篇給我吧～`);
  const platforms={}; const sym=new Set(); let firstTs=arr[0].t, lastTs=arr[0].t;
  for(const it of arr){
    platforms[it.platform]=(platforms[it.platform]||0)+1;
    it.codes.forEach(c=>sym.add(c));
    firstTs=Math.min(firstTs,it.t); lastTs=Math.max(lastTs,it.t);
  }
  const pfTxt = Object.entries(platforms).map(([k,v])=>`${k} ${v}`).join("、");
  const syms = Array.from(sym).slice(0,20).map(c=>showCodeName(c)).join("、") || "—";
  const head = `【今日 clip 摘要｜${dayjs().format("MM/DD")}】\n• 收到：${arr.length} 則（${pfTxt}）\n• 涉及股票：${syms}\n• 時間範圍：${dayjs(firstTs).format("HH:mm")}–${dayjs(lastTs).format("HH:mm")}`;
  const lines = arr.slice(-10).reverse().map((it,i)=>{
    const sn = (it.text||"").replace(/\s+/g," ").slice(0,28) || (it.kind==="圖片"?"[圖片]":"[內容]");
    const s = it.codes.length? `｜${it.codes.map(c=>CODE_TO_NAME[c]||c).slice(0,3).join("/")}` : "";
    return `${i+1}) ${it.platform} ${dayjs(it.t).format("HH:mm")}：${sn}${s}`;
  });
  await send(chatId, `${head}\n\n• 來源清單（最新→最舊）\n  ${lines.join("\n  ")}`);
}

// ===== 功能列 =====
async function tgReplyMenu(chatId){
  await tgReplyKeyboard(chatId);
  await send(chatId,
`可用指令：
/上班｜/自動｜狀態
/股價 代號或名稱（例：/股價 2374 或 /股價 佳能）
/追蹤新增 代號或名稱｜/追蹤移除 代號或名稱
/持股設定 代號 成本 35.5
/轉持股 代號 [成本 35.5]｜/轉追蹤 代號
/即時開｜/即時關｜/速報冷卻 5

清單強化：
「清單」或「清單 追蹤／持股」
「清單 排序 漲跌%（或 收盤／盈虧%）[由低到高]」
「清單 篩選 >3%」或「清單 篩選 盈虧<=-2%」
「清單 匯出 文字／CSV」

手動彙整：
「收盤彙整 立即」（同義：追蹤收盤 立即）`);
}

// ===== 指令處理 =====
async function handleCommand(chatId, rawText){
  if(!rawText) return null;
  const text = rawText.trim();
  const tNoSlash = text.startsWith("/") ? text.slice(1).trim() : text;
  const lower = tNoSlash.toLowerCase();

  // /start /menu
  if(["start","menu"].includes(lower)){ await tgReplyMenu(chatId); return {handled:true}; }

  // 模式
  if(["上班","work"].includes(lower)){ state.mode="work"; await send(chatId,"已切換：上班模式 ✅"); return {handled:true}; }
  if(["自動","auto"].includes(lower)){ state.mode="auto"; await send(chatId,"已切換：自動模式 ✅"); return {handled:true}; }

  // 狀態
  if(["狀態","status"].includes(lower)){
    await send(chatId,`台北時間：${dayjs().format("YYYY-MM-DD HH:mm")}
上班：平日 08:00–17:00
盤前導航：07:40（平日）
開盤補充：08:55（平日）
收盤彙整：16:30（平日）
洗澡提醒：${state.bathOn?"開✅":"關🚫"}（21:30）
睡覺提醒：${state.sleepOn?"開✅":"關🚫"}（23:00）
即時解析：${state.immediateOn?"開✅":"關🚫"}（冷卻 ${state.cooldownMin} 分）`);
    return {handled:true};
  }

  // 即時解析開關／冷卻
  if(["即時開","immediate on"].includes(lower)){ state.immediateOn=true; await send(chatId,"盤中即時解析：已開 ✅"); return {handled:true}; }
  if(["即時關","immediate off"].includes(lower)){ state.immediateOn=false; await send(chatId,"盤中即時解析：已關 🚫"); return {handled:true}; }
  if(tNoSlash.startsWith("速報冷卻")){
    const m=tNoSlash.match(/速報冷卻\s*([0-9]+)/); if(!m) return send(chatId,"用法：/速報冷卻 5（單位：分鐘；0＝關閉冷卻）");
    state.cooldownMin=Math.max(0, Number(m[1])); await send(chatId,`冷卻已設為 ${state.cooldownMin} 分鐘`);
    return {handled:true};
  }

  // 生活提醒開關
  if(["洗澡提醒開","bath on"].includes(lower)){ state.bathOn=true; await send(chatId,"21:30 洗澡提醒已啟用 ✅"); return {handled:true}; }
  if(["洗澡提醒關","bath off"].includes(lower)){ state.bathOn=false; await send(chatId,"21:30 洗澡提醒已關閉 🚫"); return {handled:true}; }
  if(["睡覺提醒開","sleep on"].includes(lower)){ state.sleepOn=true; await send(chatId,"23:00 睡覺提醒已啟用 ✅"); return {handled:true}; }
  if(["睡覺提醒關","sleep off"].includes(lower)){ state.sleepOn=false; await send(chatId,"23:00 睡覺提醒已關閉 🚫"); return {handled:true}; }

  // 追蹤新增／移除（名稱或代號都可）
  if(tNoSlash.startsWith("追蹤新增")){
    const q=tNoSlash.split(/\s+/).slice(1).join(" ");
    const code=resolveToCode(q); if(!code) return send(chatId,`找不到「${q}」的代號。`);
    if(state.hold[code]) delete state.hold[code]; // 若本來在持股，移出
    state.watch.add(code);
    await send(chatId,`已加入追蹤：${showCodeName(code)}`);
    return {handled:true};
  }
  if(tNoSlash.startsWith("追蹤移除")){
    const q=tNoSlash.split(/\s+/).slice(1).join(" ");
    const code=resolveToCode(q); if(!code) return send(chatId,`找不到「${q}」的代號。`);
    state.watch.delete(code);
    await send(chatId,`已移除追蹤：${showCodeName(code)}`);
    return {handled:true};
  }

  // 轉持股／轉追蹤
  if(tNoSlash.startsWith("轉持股")){
    const rest=tNoSlash.replace(/^轉持股/,"").trim();
    const q=rest.split(/\s+/)[0]; const code=resolveToCode(q);
    if(!code) return send(chatId,"用法：/轉持股 代號 [成本 35.5]");
    // 可選成本
    const mCost = rest.match(/成本\s*([0-9]+(?:\.[0-9]+)?)/);
    state.watch.delete(code);
    state.hold[code] = state.hold[code] || {};
    if(mCost) state.hold[code].cost = Number(mCost[1]);
    await send(chatId,`已轉至持股：${showCodeName(code)}${mCost?`｜成本 ${mCost[1]}`:""}`);
    return {handled:true};
  }
  if(tNoSlash.startsWith("轉追蹤") || tNoSlash.startsWith("出清")){
    const rest=tNoSlash.replace(/^轉追蹤|^出清/,"").trim();
    const q=rest.split(/\s+/)[0]; const code=resolveToCode(q);
    if(!code) return send(chatId,"用法：/轉追蹤 代號");
    delete state.hold[code]; // 清掉成本
    state.watch.add(code);
    await send(chatId,`已轉回追蹤：${showCodeName(code)}`);
    return {handled:true};
  }

  // 持股設定（新增或更新；自動從追蹤移到持股；張數不顯示）
  if(tNoSlash.startsWith("持股設定")){
    const parts=tNoSlash.split(/\s+/).slice(1);
    const q=parts[0]; const code=resolveToCode(q);
    if(!code) return send(chatId,"用法：/持股設定 代號 成本 35.5");
    const txt=tNoSlash.slice(tNoSlash.indexOf(q)+q.length).trim();
    const mCost = txt.match(/成本\s*([0-9]+(?:\.[0-9]+)?)/);
    if(!mCost) return send(chatId,"請提供成本，例如：/持股設定 2374 成本 74.5");
    state.watch.delete(code);                // 自動遷移：追蹤 → 持股
    state.hold[code]= state.hold[code] || {};
    state.hold[code].cost = Number(mCost[1]);
    await send(chatId,`已更新持股：${showCodeName(code)}｜成本 ${mCost[1]}`);
    return {handled:true};
  }

  // 清單（排序／篩選／匯出）
  if(tNoSlash.startsWith("清單")){
    const opt=parseListArgs(tNoSlash);
    if(opt.export){
      const typeText = opt.type==="watch"?"追蹤":opt.type==="hold"?"持股":"全部";
      let codes=[];
      if(opt.type==="all"||opt.type==="hold") codes.push(...Object.keys(state.hold));
      if(opt.type==="all"||opt.type==="watch") for(const c of Array.from(state.watch)) if(!state.hold[c]) codes.push(c);
      const quotes=await getBatchQuotes(codes);
      const rows=codes.map(code=>{
        const q=quotes[code];
        const close=q?.close??"";
        const chgPct=q?.chgPct==null? "": q.chgPct.toFixed(2);
        const cost=state.hold[code]?.cost??"";
        const pnl=(cost&&close)? (((close-cost)/cost*100).toFixed(2)):"";
        return {code,name:CODE_TO_NAME[code]||"",close,chgPct,cost,pnl};
      });
      // 排序
      if(opt.sortBy){
        const key=r=> opt.sortBy==="chg"? (r.chgPct===""?-9e9:Number(r.chgPct)) :
                        opt.sortBy==="close"? (r.close===""?-9e9:Number(r.close)) :
                        (r.pnl===""?-9e9:Number(r.pnl));
        rows.sort((a,b)=> opt.sortDir==="asc"? key(a)-key(b) : key(b)-key(a));
      }
      // 篩選
      if(opt.filter){
        const f=opt.filter;
        const pick = r=>{
          const val = f.field==="收盤"||f.field==="close"? Number(r.close||NaN) :
                      f.field==="盈虧%"||f.field==="pnl"? Number(r.pnl||NaN) :
                      Number(r.chgPct||NaN);
          const tgt = Number(f.value);
          if(Number.isNaN(val)||Number.isNaN(tgt)) return false;
          return f.op===">"? val>tgt : f.op===">="? val>=tgt : f.op==="<"? val<tgt : f.op==="<="? val<=tgt : Math.abs(val-tgt)<1e-9;
        };
        for(let i=rows.length-1;i>=0;i--) if(!pick(rows[i])) rows.splice(i,1);
      }
      if(opt.export==="CSV"){
        const header="code,name,close,chg_pct,cost,pnl_pct";
        const lines=rows.map(r=>`${r.code},${r.name},${r.close},${r.chgPct},${r.cost},${r.pnl}`);
        const csv=[header,...lines].join("\n");
        await send(chatId, `【清單匯出（${typeText}）CSV】\n<code>${csv}</code>`, { disable_web_page_preview:true });
      }else{
        const lines=rows.slice(0,50).map(r=>{
          const chg=r.chgPct===""? "—" : `${Number(r.chgPct)>=0?"+":""}${r.chgPct}%`;
          const pnl=r.pnl===""? "" : `｜盈虧 ${Number(r.pnl)>=0?"+":""}${r.pnl}%`;
          return `${r.code} ${r.name}　收 ${r.close||"—"}（${chg}）${pnl}`;
        });
        await send(chatId, `【清單匯出（${typeText}）文字】\n${lines.join("\n")}`);
      }
      return {handled:true};
    }
    await showList(chatId, { type: opt.type, sortBy: opt.sortBy, sortDir: opt.sortDir, filter: opt.filter });
    return {handled:true};
  }

  // 查價（口語）
  const m1=tNoSlash.match(/^(?:股價|查|查價)\s+(.+)$/);
  if(m1){
    const code=resolveToCode(m1[1]); if(!code) return send(chatId,`找不到「${m1[1]}」的代號。`);
    const q=await getDailyOHLC(code).catch(()=>null);
    if(!q) return send(chatId,`查不到 ${showCodeName(code)} 的收盤資料。`);
    const chg=(q.prevClose && q.prevClose>0)?((q.close-q.prevClose)/q.prevClose*100):null;
    const body=`【${showCodeName(code)}｜${q.source}】\n日期：${q.date}\n開盤：${q.open}\n最高：${q.high}\n最低：${q.low}\n收盤：${q.close}${chg!=null?`\n漲跌：${chg>=0?"+":""}${chg.toFixed(2)}%`:""}`;
    await send(chatId, body);
    return {handled:true};
  }

  // 手動：收盤彙整 立即（同義：追蹤收盤 立即）
  if(/^(收盤彙整\s*立即|追蹤收盤\s*立即)$/i.test(tNoSlash)){
    const holdCodes=Object.keys(state.hold);
    const watchOnly = Array.from(state.watch).filter(c=>!state.hold[c]);
    const allCodes=[...holdCodes, ...watchOnly];
    if(allCodes.length===0){ await send(chatId,"（目前沒有任何持股或追蹤標的）"); return {handled:true}; }
    const quotes=await getBatchQuotes(allCodes);
    const fmt=(code)=>{
      const q=quotes[code]; if(!q) return `${showCodeName(code)}　收 —（—）`;
      const chg=(q.chgPct==null)?"—":`${q.chgPct>=0?"+":""}${q.chgPct.toFixed(2)}%`;
      return `${showCodeName(code)}　收 ${q.close.toFixed(2)}（${chg}）`;
    };
    const a1 = holdCodes.length? `【持股】\n`+holdCodes.map(fmt).join("\n") : "";
    const a2 = watchOnly.length? `\n${holdCodes.length? "\n":""}【追蹤】\n`+watchOnly.map(fmt).join("\n") : "";
    await send(chatId, `【收盤彙整｜${dayjs().format("MM/DD")}】\n${a1}${a2}`);
    return {handled:true};
  }

  // 快捷鍵
  if(lower==="查價"){ await send(chatId,"請輸入：股價 代號　或　股價 名稱（例：股價 2330 / 股價 佳能）"); return {handled:true}; }
  if(lower==="清單"){ await showList(chatId,{}); return {handled:true}; }
  if(lower==="clip 摘要 今日"||lower==="clip摘要 今日"){ await showClipSummaryToday(chatId); return {handled:true}; }

  if(text.startsWith("/")) return {handled:true};
  return null;
}

// ===== webhook：message + callback_query =====
app.post("/webhook",(req,res)=>{
  res.sendStatus(200);
  const run = async ()=>{
    try{
      const update=req.body;

      // 內嵌按鈕
      if(update.callback_query){
        const cq=update.callback_query;
        const chatId=String(cq.message.chat.id);
        const msgId=cq.message.message_id;
        const data=cq.data||"";
        if(data.startsWith("PRICE:")){
          const code=data.split(":")[1];
          const q=await getDailyOHLC(code).catch(()=>null);
          if(!q) return edit(chatId,msgId,`${showCodeName(code)}：暫無收盤資料`);
          const chg=(q.prevClose && q.prevClose>0)?((q.close-q.prevClose)/q.prevClose*100):null;
          const txt=`【${showCodeName(code)}｜${q.source}】\n日期：${q.date}\n收盤：${q.close}${chg!=null?`（${chg>=0?"+":""}${chg.toFixed(2)}%）`:""}`;
          return edit(chatId,msgId,txt, { reply_markup: inlineRowFor(code, state.hold[code]?"hold":"watch") });
        }
        if(data.startsWith("REMOVE:")){
          const [,kind,code] = data.split(":");
          if(kind==="watch") state.watch.delete(code);
          if(kind==="hold") delete state.hold[code];
          return edit(chatId,msgId,`已移除：${showCodeName(code)}`);
        }
        if(data.startsWith("SETCOST:")){
          const code=data.split(":")[1];
          await send(chatId,`請回覆：/持股設定 ${code} 成本 35.5`);
          return;
        }
        return;
      }

      // message
      const msg = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
      if(!msg) return;
      const chatId=String(msg.chat.id);
      const text=(msg.text||msg.caption||"").trim();

      // 1) 指令/快捷
      const handled = await handleCommand(chatId,text);
      if(handled!==null) return;

      // 2) 一般訊息（轉貼/文字/圖片）→ A 模式：入庫 + 推播策略
      const meta = pushClipFromMessage(msg);
      // 上班：精簡；非上班：完整；同時啟動冷卻彙整
      if(state.immediateOn){
        if(isWeekday() && Number(dayjs().format("H"))>=8 && Number(dayjs().format("H"))<17){
          const hit = meta.codes.length? `標的：${markHits(meta.codes)}` : "標的：—";
          await send(chatId, `【即時解析｜精簡】${hit}`);
        }else{
          await pushImmediateCard(chatId, meta);
        }
      }
      scheduleBurstSend(chatId);
    }catch(e){ console.error("webhook handler error:", e); }
  };
  if(typeof queueMicrotask==="function") queueMicrotask(run); else setImmediate(run);
});

// ===== 健康檢查／ping =====
app.get("/",(req,res)=>res.json({ok:true,service:"orbit07-webhook",now_taipei:dayjs().format("YYYY-MM-DD HH:mm:ss")}));
app.get("/health",(req,res)=>res.json({ok:true,service:"orbit07-webhook",now_taipei:dayjs().format("YYYY-MM-DD HH:mm:ss")}));
app.get("/ping", async (req,res)=>{
  try{ const j=await send(CHAT_ID, req.query.text||"Ping ✅"); res.json(j); }
  catch(e){ res.status(500).json({ok:false}); }
});

// ===== 排程 =====
// 07:40：盤前導航（平日）
cron.schedule("40 7 * * 1-5", async ()=>{ try{ if(!isWeekday()) return;
  await send(CHAT_ID,`【盤前導航｜07:40】（模板：之後由戀股資料庫 + clip 整合產生）`);
}catch(e){} }, { timezone:"Asia/Taipei" });

// 08:55：開盤補充（平日）
cron.schedule("55 8 * * 1-5", async ()=>{ try{ if(!isWeekday()) return;
  await send(CHAT_ID,`【開盤補充｜08:55】（模板）`);
}catch(e){} }, { timezone:"Asia/Taipei" });

// 16:30：收盤後提醒（平日）
cron.schedule("30 16 * * 1-5", async ()=>{ try{ if(!isWeekday()) return;
  await send(CHAT_ID,"【提醒】收盤囉～要不要記今天的戀股日誌？");
}catch(e){} }, { timezone:"Asia/Taipei" });

// 21:30／23:00 生活提醒（每日，可關）
cron.schedule("30 21 * * *", async ()=>{ try{ if(state.bathOn)  await send(CHAT_ID,"【提醒】21:30 到了，去洗澡放鬆一下～🛁"); }catch(e){} }, { timezone:"Asia/Taipei" });
cron.schedule("0 23 * * *",  async ()=>{ try{ if(state.sleepOn) await send(CHAT_ID,"【提醒】23:00 到了，收心上床睡覺囉～😴"); }catch(e){} }, { timezone:"Asia/Taipei" });

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`✅ webhook server listening on ${PORT}`));
