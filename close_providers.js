// close_providers.js — 個股「日收盤」供應器（TWSE 正式 + TPEx 容錯）
// Node 18+ 原生 fetch
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjsBase.extend(utc); dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

const NUM = (s) => {
  const v = parseFloat(String(s ?? "").replace(/,/g, "").replace(/\s/g, ""));
  return Number.isFinite(v) ? v : null;
};
const lastTruthy = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i]) return arr[i]; return null; };

// ---- TWSE：官方 RWD 日線（穩定）----
async function getDailyCloseTWSE(code) {
  try {
    const ymd = dayjs().format("YYYYMMDD");
    const u = new URL("https://www.twse.com.tw/rwd/zh/exchangeReport/STOCK_DAY");
    u.search = new URLSearchParams({ response: "json", date: ymd, stockNo: code }).toString();
    const r = await fetch(u.toString(), { headers: { "cache-control":"no-cache" } });
    const j = await r.json().catch(()=>null);
    const rows = j?.data || [];
    if (!rows.length) return null;
    const last = rows[rows.length - 1]; // ["日期","成交股數","成交金額","開盤價","最高價","最低價","收盤價",...]
    const open = NUM(last[3]), high = NUM(last[4]), low = NUM(last[5]), close = NUM(last[6]);
    if (close == null) return null;
    return { market: "TWSE", date: j.date || dayjs().format("YYYY/MM/DD"), open, high, low, close };
  } catch (e) { console.error("[getDailyCloseTWSE] err", e); return null; }
}

// ---- TPEx：多端點容錯（JSON/CSV 都試）----
async function getDailyCloseTPEx(code) {
  const ymd = dayjs().format("YYYYMMDD");
  const ym  = dayjs().format("YYYY/MM");
  const candidates = [
    // JSON 端點（不同環境可能有其一可用）
    `https://www.tpex.org.tw/openapi/v1/tpex_mainboard_stock_day?stockNo=${code}&date=${ymd}`,
    `https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close?stockNo=${code}&date=${ymd}`,
    // 舊站 CSV：st43 下載
    `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_download.php?stkno=${code}&d=${ym}`
  ];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: { "cache-control":"no-cache" } });
      if (!r.ok) continue;
      const ct = (r.headers.get("content-type") || "").toLowerCase();

      if (ct.includes("json")) { // JSON 解析
        const j = await r.json().catch(()=>null);
        const rows = Array.isArray(j) ? j : (j?.data || []);
        if (!rows.length) continue;
        const last = lastTruthy(rows); if (!last) continue;
        const open  = NUM(last.open  ?? last["開盤價"]);
        const high  = NUM(last.high  ?? last["最高價"]);
        const low   = NUM(last.low   ?? last["最低價"]);
        const close = NUM(last.close ?? last["收盤價"]);
        const date  = (last.date ?? last["日期"] ?? dayjs().format("YYYY/MM/DD"));
        if (close == null) continue;
        return { market:"TPEx", date, open, high, low, close };
      } else { // CSV 解析
        const txt = await r.text();
        const lines = txt.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          const cols = lines[i].split(/,|;|\t/).map(s=>s.trim());
          if (cols.length < 6) continue;
          const tryParse = (arr, di, oi) => {
            const date = arr[di] || arr[di+1] || "";
            const open = NUM(arr[oi]), high = NUM(arr[oi+1]), low = NUM(arr[oi+2]), close = NUM(arr[oi+3]);
            return [open,high,low,close].every(v=>v!=null) ? { date, open, high, low, close } : null;
          };
          const parsed = tryParse(cols, 0, 3) || tryParse(cols, 1, 4);
          if (parsed) return { market:"TPEx", ...parsed };
        }
      }
    } catch (e) {
      console.warn("[getDailyCloseTPEx] candidate fail:", url, String(e).slice(0,120));
    }
  }
  return null;
}

/** 智慧選源：有 marketHint 先試該市場；否則 TWSE → TPEx */
async function getDailyClose(code, marketHint) {
  if (marketHint === "TPEx") return (await getDailyCloseTPEx(code)) || (await getDailyCloseTWSE(code));
  return (await getDailyCloseTWSE(code)) || (await getDailyCloseTPEx(code));
}

module.exports = { getDailyClose, getDailyCloseTWSE, getDailyCloseTPEx };
