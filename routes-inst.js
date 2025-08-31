// routes-inst.js — TWSE 三大法人（T86明細／全市場彙總；免金鑰）
const axios = require("axios");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const num = (s) => { if (s == null) return null; const n = Number(String(s).replace(/,/g, "").trim()); return Number.isFinite(n) ? n : null; };
const findIdx = (fields, ...kw) => fields.findIndex(f => kw.every(k => f.includes(k)));

async function fetchT86(date) {
  const urls = [
    `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${date}&selectType=ALLBUT0999`,
    `https://www.twse.com.tw/fund/T86?response=json&date=${date}&selectType=ALLBUT0999`,
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const { data } = await axios.get(url, { timeout: 15000, headers: { "User-Agent": UA, Accept: "application/json" } });
      const fields = data?.fields || data?.["fields"]; const rows = data?.data || data?.["data"];
      if (fields && rows) return { ok: true, fields, rows, date: data?.date || date, raw: data };
    } catch (e) { lastErr = e; }
  }
  return { ok: false, error: lastErr?.message || "T86 fetch failed" };
}

function normalizeT86(fields, rows, codesSet) {
  const idx = {
    code: findIdx(fields, "證券", "代號"),
    name: findIdx(fields, "證券", "名稱"),
    foreignNetAmt: findIdx(fields, "外資", "買賣超", "金額"),
    foreignNetShares: findIdx(fields, "外資", "買賣超", "股數"),
    trustNetAmt: findIdx(fields, "投信", "買賣超", "金額"),
    trustNetShares: findIdx(fields, "投信", "買賣超", "股數"),
    dealerNetAmt: findIdx(fields, "自營商", "買賣超", "金額"),
    dealerNetShares: findIdx(fields, "自營商", "買賣超", "股數"),
    totalNetAmt: findIdx(fields, "三大法人", "買賣超", "金額"),
    totalNetShares: findIdx(fields, "三大法人", "買賣超", "股數"),
  };
  const out = [];
  for (const r of rows) {
    const code = String(r[idx.code] || "").trim(); if (!code) continue;
    if (codesSet && !codesSet.has(code)) continue;
    out.push({
      code, name: String(r[idx.name] ?? "").trim(),
      foreign: { net_shares: num(r[idx.foreignNetShares]), net_amount: num(r[idx.foreignNetAmt]) },
      trust:   { net_shares: num(r[idx.trustNetShares]),   net_amount: num(r[idx.trustNetAmt]) },
      dealer:  { net_shares: num(r[idx.dealerNetShares]),  net_amount: num(r[idx.dealerNetAmt]) },
      total:   { net_shares: num(r[idx.totalNetShares]),   net_amount: num(r[idx.totalNetAmt]) },
    });
  }
  return out;
}

function aggregateSummary(items) {
  const sum = { foreign:{net_shares:0,net_amount:0}, trust:{net_shares:0,net_amount:0}, dealer:{net_shares:0,net_amount:0}, total:{net_shares:0,net_amount:0} };
  for (const it of items) for (const k of ["foreign","trust","dealer","total"]) {
    sum[k].net_shares += it[k].net_shares || 0; sum[k].net_amount += it[k].net_amount || 0;
  }
  const sorted = [...items].sort((a,b)=>(b.total.net_amount||0)-(a.total.net_amount||0));
  return { sum, top_buy: sorted.slice(0,10), top_sell: sorted.slice(-10).reverse() };
}
const todayYMD = ()=>{ const d=new Date(); const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,"0"); const dd=String(d.getDate()).padStart(2,"0"); return `${y}${m}${dd}`; };

module.exports = function mountTWSEInst(app){
  app.get("/tw/inst/t86", async (req, res) => {
    const date = String(req.query.date || todayYMD());
    const codes = String(req.query.codes||"").split(",").map(s=>s.trim()).filter(Boolean);
    const codesSet = codes.length ? new Set(codes) : null;
    try {
      const r = await fetchT86(date);
      if (!r.ok) return res.status(502).json({ ok:false, error:r.error });
      const items = normalizeT86(r.fields, r.rows, codesSet);
      res.json({ ok:true, date: r.date || date, count: items.length, items, source:"TWSE:T86" });
    } catch(e){ res.status(502).json({ ok:false, error:String(e?.message||e) }); }
  });

  app.get("/tw/inst/summary", async (req, res) => {
    const date = String(req.query.date || todayYMD());
    try {
      const r = await fetchT86(date);
      if (!r.ok) return res.status(502).json({ ok:false, error:r.error });
      const items = normalizeT86(r.fields, r.rows, null);
      const agg = aggregateSummary(items);
      res.json({ ok:true, date: r.date || date, source:"TWSE:T86", sum: agg.sum, top_buy: agg.top_buy, top_sell: agg.top_sell });
    } catch(e){ res.status(502).json({ ok:false, error:String(e?.message||e) }); }
  });
};
