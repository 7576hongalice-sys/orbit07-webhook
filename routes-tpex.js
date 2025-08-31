// routes-tpex.js — TPEx 上櫃 三大法人（明細／彙總；免金鑰；CSV優先，OpenAPI備援）
const axios = require("axios");
const BASE = "https://www.tpex.org.tw";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const num = (s)=>{ if(s==null) return null; const n=Number(String(s).replace(/,/g,"").trim()); return Number.isFinite(n)?n:null; };
const todayYMD = ()=>{ const d=new Date(); const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,"0"); const dd=String(d.getDate()).padStart(2,"0"); return `${y}${m}${dd}`; };
const ymdToRoc = (ymd)=>{ const y=Number(ymd.slice(0,4))-1911; const m=ymd.slice(4,6); const d=ymd.slice(6,8); return `${y}/${m}/${d}`; };

function absUrl(href){ if(!href) return null; if(/^https?:\/\//i.test(href)) return href; return BASE + (href.startsWith("/")? href : "/"+href); }

// 極簡 CSV 解析（支援引號與逗號）
function parseCSV(text){
  const rows=[]; let i=0, field="", row=[], inQ=false;
  const pushField=()=>{ row.push(field); field=""; };
  const pushRow=()=>{ rows.push(row); row=[]; };
  while(i<text.length){
    const c=text[i];
    if(inQ){
      if(c=='"'){
        if(text[i+1]=='"'){ field+='"'; i+=2; continue; }
        inQ=false; i++; continue;
      } else { field+=c; i++; continue; }
    }else{
      if(c=='"'){ inQ=true; i++; continue; }
      if(c==','){ pushField(); i++; continue; }
      if(c=='\r'){ i++; continue; }
      if(c=='\n'){ pushField(); pushRow(); i++; continue; }
      field+=c; i++; continue;
    }
  }
  if(field.length || row.length){ pushField(); pushRow(); }
  // 去掉空白列
  return rows.filter(r => r.some(x => String(x||"").trim()!==""));
}

// 從頁面擷取「下載CSV」連結（summary 或 detail 頁）
async function findCsvLink(pageUrl){
  const { data: html } = await axios.get(pageUrl, { timeout: 15000, headers: { "User-Agent": UA } });
  // 優先找文字為「下載CSV」的 a 連結
  let m = html.match(/<a[^>]+href="([^"]+\.csv[^"]*)"[^>]*>\s*下載\s*CSV\s*<\/a>/i);
  if (m && m[1]) return absUrl(m[1]);
  // 退而求其次：找任何 .csv 連結
  m = html.match(/href="([^"]+\.csv[^"]*)"/i);
  if (m && m[1]) return absUrl(m[1]);
  return null;
}

// 嘗試多組 OpenAPI（若 CSV 找不到）
async function tryTpexOpenAPI(kind, ymd){
  const candidates = [];
  // 官方 OpenAPI 入口常見路徑，實務觀察多為 openapi/v1/xxx
  if (kind === "summary") {
    candidates.push(`${BASE}/openapi/v1/tpex_3insti_trading?date=${ymd}`);
    candidates.push(`${BASE}/openapi/v1/tpex_3insti_trading?startDate=${ymd}&endDate=${ymd}`);
  } else {
    // 明細
    candidates.push(`${BASE}/openapi/v1/tpex_3insti_detail?date=${ymd}`);
    candidates.push(`${BASE}/openapi/v1/tpex_3insti_detail?startDate=${ymd}&endDate=${ymd}`);
  }
  for (const url of candidates) {
    try {
      const { data } = await axios.get(url, { timeout: 15000, headers: { "User-Agent": UA, Accept: "application/json" } });
      if (Array.isArray(data) && data.length) return { ok:true, data, api:url };
      if (Array.isArray(data?.data) && data.data.length) return { ok:true, data: data.data, api:url };
    } catch { /* try next */ }
  }
  return { ok:false };
}

// === Summary（全市場合計 + Top10） ==================================
async function tpexSummary(ymd){
  const roc = ymdToRoc(ymd);
  const page = `${BASE}/zh-tw/mainboard/trading/major-institutional/summary/day.html?d=${encodeURIComponent(roc)}`;
  let items = null, source="TPEx:CSV", api=null;

  try {
    const csvLink = await findCsvLink(page);
    if (csvLink) {
      const { data: csvText } = await axios.get(csvLink, { timeout: 15000, headers: { "User-Agent": UA } });
      const rows = parseCSV(csvText);
      // 期望表頭包含：單位/買進/賣出 等；我們找出關鍵列
      // 依關鍵字萃取（外資、投信、自營商）
      const foreignRow = rows.find(r => r.join("").includes("外資"));
      const trustRow   = rows.find(r => r.join("").includes("投信"));
      const dealerRow  = rows.find(r => r.join("").includes("自營商"));
      function pick(row){
        if(!row) return { buy:null, sell:null, net_amount:null };
        const nums = row.map(num).filter(n => Number.isFinite(n));
        // 假設前兩個數字是 買進/賣出（此處做保守擷取）
        const buy = nums[0] ?? null;
        const sell = nums[1] ?? null;
        const net_amount = (buy!=null && sell!=null) ? (buy - sell) : null;
        return { buy, sell, net_amount };
      }
      const foreign = pick(foreignRow);
      const trust   = pick(trustRow);
      const dealer  = pick(dealerRow);
      const sum = {
        foreign: { net_shares: null, net_amount: foreign.net_amount },
        trust:   { net_shares: null, net_amount: trust.net_amount   },
        dealer:  { net_shares: null, net_amount: dealer.net_amount  },
        total:   { net_shares: null, net_amount: [foreign.net_amount,trust.net_amount,dealer.net_amount].map(x=>x||0).reduce((a,b)=>a+b,0) }
      };
      // 取 Top10 需用明細，再叫一次 detail
      const det = await tpexDetail(ymd, null);
      const sorted = [...det.items].sort((a,b)=>(b.total.net_amount||0)-(a.total.net_amount||0));
      const top_buy = sorted.slice(0,10);
      const top_sell = sorted.slice(-10).reverse();
      return { ok:true, date: ymd, source, sum, top_buy, top_sell };
    }
  } catch { /* 轉用 API 備援 */ }

  // OpenAPI 備援
  const r = await tryTpexOpenAPI("summary", ymd);
  if (r.ok) {
    api = r.api; source = "TPEx:OpenAPI";
    // 嘗試從欄位名萃取：外資/投信/自營商 淨額
    const foreignAmt = num(r.data.find(it => Object.values(it).join("").includes("外資"))?.netAmount ?? null);
    const trustAmt   = num(r.data.find(it => Object.values(it).join("").includes("投信"))?.netAmount ?? null);
    const dealerAmt  = num(r.data.find(it => Object.values(it).join("").includes("自營"))?.netAmount ?? null);
    const sum = {
      foreign:{ net_shares:null, net_amount:foreignAmt||0 },
      trust:{ net_shares:null, net_amount:trustAmt||0 },
      dealer:{ net_shares:null, net_amount:dealerAmt||0 },
      total:{ net_shares:null, net_amount:(foreignAmt||0)+(trustAmt||0)+(dealerAmt||0) }
    };
    // Top10 仍靠 detail
    const det = await tpexDetail(ymd, null);
    const sorted = [...det.items].sort((a,b)=>(b.total.net_amount||0)-(a.total.net_amount||0));
    return { ok:true, date: ymd, source, api, sum, top_buy: sorted.slice(0,10), top_sell: sorted.slice(-10).reverse() };
  }

  return { ok:false, error:"TPEx summary not available (CSV & OpenAPI both failed)" };
}

// === Detail（個股明細；可帶 codes） ================================
async function tpexDetail(ymd, codesSet){
  const roc = ymdToRoc(ymd);
  const page = `${BASE}/zh-tw/mainboard/trading/major-institutional/detail/day.html?d=${encodeURIComponent(roc)}`;
  let source="TPEx:CSV", api=null;

  // 先試 CSV
  try {
    const csvLink = await findCsvLink(page);
    if (csvLink) {
      const { data: csvText } = await axios.get(csvLink, { timeout: 15000, headers: { "User-Agent": UA } });
      const rows = parseCSV(csvText);
      // 期望欄位：日期,代號,名稱,外資買賣超(股/金額),投信...,自營商...,合計...
      // 自動尋找欄位索引
      const header = rows[0] || [];
      const findIdx = (pred)=> header.findIndex(h=>pred(String(h)));
      const idx = {
        date: findIdx(h=>h.includes("日期")),
        code: findIdx(h=>h.includes("代號")),
        name: findIdx(h=>h.includes("名稱")),
        f_net_amt: findIdx(h=>/外資/.test(h) && /金額/.test(h)),
        f_net_sh:  findIdx(h=>/外資/.test(h) && /(股|張)/.test(h) && !/金額/.test(h)),
        t_net_amt: findIdx(h=>/投信/.test(h) && /金額/.test(h)),
        t_net_sh:  findIdx(h=>/投信/.test(h) && /(股|張)/.test(h) && !/金額/.test(h)),
        d_net_amt: findIdx(h=>/自營/.test(h) && /金額/.test(h)),
        d_net_sh:  findIdx(h=>/自營/.test(h) && /(股|張)/.test(h) && !/金額/.test(h)),
        tot_net_amt: findIdx(h=>/三大法人/.test(h) && /金額/.test(h)),
        tot_net_sh:  findIdx(h=>/三大法人/.test(h) && /(股|張)/.test(h) && !/金額/.test(h)),
      };
      const items=[];
      for (let i=1;i<rows.length;i++){
        const r = rows[i]; if (!r) continue;
        const code = String(r[idx.code]||"").trim();
        if (!code) continue;
        if (codesSet && !codesSet.has(code)) continue;
        items.push({
          code, name: String(r[idx.name]||"").trim(),
          foreign: { net_shares: num(r[idx.f_net_sh]), net_amount: num(r[idx.f_net_amt]) },
          trust:   { net_shares: num(r[idx.t_net_sh]), net_amount: num(r[idx.t_net_amt]) },
          dealer:  { net_shares: num(r[idx.d_net_sh]), net_amount: num(r[idx.d_net_amt]) },
          total:   { net_shares: num(r[idx.tot_net_sh]), net_amount: num(r[idx.tot_net_amt]) },
        });
      }
      return { ok:true, date: ymd, items, source };
    }
  } catch { /* 轉 API 備援 */ }

  // OpenAPI 備援
  const r = await tryTpexOpenAPI("detail", ymd);
  if (r.ok) {
    api = r.api; source = "TPEx:OpenAPI";
    const items = [];
    for (const it of r.data) {
      const code = String(it.StockID || it.stock_id || it.code || "").trim();
      if (!code) continue;
      if (codesSet && !codesSet.has(code)) continue;
      items.push({
        code,
        name: String(it.SecurityName || it.name || it.stock_name || "").trim(),
        foreign: { net_shares: num(it.ForeignNetShares ?? it.foreign_net_shares), net_amount: num(it.ForeignNetAmount ?? it.foreign_net_amount) },
        trust:   { net_shares: num(it.TrustNetShares   ?? it.trust_net_shares),   net_amount: num(it.TrustNetAmount   ?? it.trust_net_amount) },
        dealer:  { net_shares: num(it.DealerNetShares  ?? it.dealer_net_shares),  net_amount: num(it.DealerNetAmount  ?? it.dealer_net_amount) },
        total:   { net_shares: num(it.TotalNetShares   ?? it.total_net_shares),   net_amount: num(it.TotalNetAmount   ?? it.total_net_amount) },
      });
    }
    return { ok:true, date: ymd, items, source, api };
  }

  return { ok:false, error:"TPEx detail not available (CSV & OpenAPI both failed)" };
}

module.exports = function mountTPEx(app){
  // /tpex/inst/t86?date=YYYYMMDD&codes=2330,2603
  app.get("/tpex/inst/t86", async (req, res) => {
    const date = String(req.query.date || todayYMD());
    const codes = String(req.query.codes||"").split(",").map(s=>s.trim()).filter(Boolean);
    const codesSet = codes.length ? new Set(codes) : null;
    try {
      const r = await tpexDetail(date, codesSet);
      if (!r.ok) return res.status(502).json({ ok:false, error:r.error });
      res.json({ ok:true, date:r.date, count:r.items.length, items:r.items, source:r.source, api:r.api });
    } catch(e){ res.status(502).json({ ok:false, error:String(e?.message||e) }); }
  });

  // /tpex/inst/summary?date=YYYYMMDD
  app.get("/tpex/inst/summary", async (req, res) => {
    const date = String(req.query.date || todayYMD());
    try {
      const r = await tpexSummary(date);
      if (!r.ok) return res.status(502).json({ ok:false, error:r.error });
      res.json({ ok:true, date:r.date, source:r.source, api:r.api, sum:r.sum, top_buy:r.top_buy, top_sell:r.top_sell });
    } catch(e){ res.status(502).json({ ok:false, error:String(e?.message||e) }); }
  });
};
