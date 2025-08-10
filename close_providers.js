// close_providers.js — 個股「日收盤」供應器（TWSE 正式 + TPEx 容錯）
// Node 18+ 原生 fetch
const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjsBase.extend(utc); dayjsBase.extend(timezone);
const dayjs = (d) => dayjsBase.tz(d, "Asia/Taipei");

// ---- helpers ----
const NUM = (s) => {
  const v = parseFloat(String(s ?? "").replace(/,/g, "").replace(/\s/g, ""));
  return Number.isFinite(v) ? v : null;
};
const lastTruthy = (arr) => {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i]) return arr[i];
  return null;
};

// ---- TWSE：官方 RWD 日線（穩定）----
// 回傳 { market:"TWSE", date:"YYYY/MM/DD", open, high, low, close } | null
async function getDailyCloseTWSE(code) {
  try {
    const ymd = dayjs().format("YYYYMMDD"); // 傳今天，會回該月所有日線
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
  } catch (e) {
    console.error("[getDailyCloseTWSE] err", e);
    return null;
  }
}

// ---- TPEx：多端點容錯（會自動嘗試，能吃 JSON 或 CSV）----
// 回傳 { market:"TPEx", date, open, high, low, close } | null
async function getDailyCloseTPEx(code) {
  // 嘗試清單（可能有一兩個失敗也無所謂）
  const ymd = dayjs().format("YYYYMMDD");
  const ym  = dayjs().format("YYYY/MM");

  // 1) 想像中的 OpenAPI（有些環境可用）
  const candidates = [
    // JSON 類（key 可能是英文或中文）
    `https://www.tpex.org.tw/openapi/v1/tpex_mainboard_stock_day?stockNo=${code}&date=${ymd}`,
    `https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close?stockNo=${code}&date=${ymd}`,

    // 舊站 CSV（常見 st43 下載）
    `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_download.php?stkno=${code}&d=${ym}`
  ];

  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: { "cache-control":"no-cache" } });
      const ctype = (r.headers.get("content-type") || "").toLowerCase();
      if (!r.ok) continue;

      // JSON 解析
      if (ctype.includes("json")) {
        const j = await r.json().catch(()=>null);
        if (!j) continue;

        // 可能是 {data:[...]} 或直接陣列
        const rows = Array.isArray(j) ? j : (j.data || []);
        if (!rows.length) continue;

        const last = lastTruthy(rows);
        if (!last) continue;

        // 英文或中文鍵名皆容錯
        const open  = NUM(last.open  ?? last["開盤價"]);
        const high  = NUM(last.high  ?? last["最高價"]);
        const low   = NUM(last.low   ?? last["最低價"]);
        const close = NUM(last.close ?? last["收盤價"]);
        const date  = (last.date ?? last["日期"] ?? dayjs().format("YYYY/MM/DD"));
        if (close == null) continue;

        return { market:"TPEx", date, open, high, low, close };
      }

      // CSV 解析（st43_download）
      const txt = await r.text();
      // 找最後一列含有 5 個以上數字欄位者
      const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!lines.length) continue;

      // 允許有標題列，從底部往上找第一個「像資料列」的
      for (let i = lines.length - 1; i >= 0; i--) {
        const cols = lines[i].split(/,|;|\t/).map(s=>s.trim());
        if (cols.length < 6) continue;

        // 嘗試推測欄位：日期在第1~2欄，開高低收在其後
        const tryParse = (arr, di, oi) => {
          const date = arr[di] || arr[di+1] || "";
          const open = NUM(arr[oi]), high = NUM(arr[oi+1]), low = NUM(arr[oi+2]), close = NUM(arr[oi+3]);
          if ([open,high,low,close].every(v => v !== null)) return { date, open, high, low, close };
          return null;
        };

        let parsed = tryParse(cols, 0, 3) || tryParse(cols, 1, 4) || null;
        if (!parsed) continue;

        return { market:"TPEx", ...parsed };
      }
    } catch (e) {
      // 單一候選失敗就換下一個，僅記錄
      console.warn("[getDailyCloseTPEx] candidate fail:", url, String(e).slice(0,120));
    }
  }
  return null;
}

/**
 * 智慧選源：
 * - 若傳入 marketHint（"TWSE"|"TPEx"）則優先該源，再退回另一邊。
 * - 未指定時預設先 TWSE 再 TPEx（多數代號在上市）。
 */
async function getDailyClose(code, marketHint) {
  if (marketHint === "TPEx") {
    return (await getDailyCloseTPEx(code)) || (await getDailyCloseTWSE(code));
  }
  return (await getDailyCloseTWSE(code)) || (await getDailyCloseTPEx(code));
}

module.exports = { getDailyClose, getDailyCloseTWSE, getDailyCloseTPEx };
