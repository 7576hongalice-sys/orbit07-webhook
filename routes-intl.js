// routes-intl.js — 國際盤勢 + 白名單新聞
// CommonJS, Node 18+
// 依賴：axios、rss-parser（已在 package.json）
// 需要環境變數（可選，但強烈建議）：
//   ALPHA_VANTAGE_KEY = <你的 Alpha Vantage API key>
//   FRED_KEY          = <你的 FRED API key>   // 可不填，缺料就不抓 FRED

const axios = require("axios");
const RSSParser = require("rss-parser");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const AV_KEY = process.env.ALPHA_VANTAGE_KEY || "";
const FRED_KEY = process.env.FRED_KEY || "";

const parser = new RSSParser({
  headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml" },
});

// ---------- 小工具 ----------

function isoDate(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function lastNonEmptyFred(rows) {
  // 取最後一筆非空值
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = Number(rows[i]?.value);
    if (Number.isFinite(v)) return { date: rows[i].date, value: v };
  }
  return null;
}

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return +(((a - b) / b) * 100).toFixed(2);
}

// ---------- Alpha Vantage（第三層備援 / 或強制 alpha=1） ----------
// 用 GLOBAL_QUOTE 取：close / previousClose / changePercent
async function alphaGlobalQuote(symbol) {
  if (!AV_KEY) return { ok: false, reason: "alpha key missing" };
  const url = "https://www.alphavantage.co/query";
  try {
    const { data } = await axios.get(url, {
      params: { function: "GLOBAL_QUOTE", symbol, apikey: AV_KEY },
      timeout: 12000,
      headers: { "User-Agent": UA },
    });

    if (data?.Note || data?.Information) {
      return { ok: false, reason: "alpha rate/frequency", raw: data };
    }
    const q = data?.["Global Quote"] || {};
    const c = Number(q["05. price"]);
    const pc = Number(q["08. previous close"]);
    const cpctStr = q["10. change percent"];
    const cpct = cpctStr
      ? Number(cpctStr.replace("%", ""))
      : pct(c, pc);

    if (!Number.isFinite(c)) {
      return { ok: false, reason: "alpha no data", raw: data };
    }

    return {
      ok: true,
      close: c,
      pct: Number.isFinite(cpct) ? +cpct.toFixed(2) : null,
      prev: Number.isFinite(pc) ? pc : null,
    };
  } catch (e) {
    return { ok: false, reason: e?.message || "alpha error" };
  }
}

// ---------- FRED 宏觀 ----------
// 使用常見指標：DXY 使用 DTWEXM（名義美元指數-主要貨幣）、10Y = DGS10、WTI = DCOILWTICO、Brent = DCOILBRENTEU
async function fredSeries(seriesId) {
  if (!FRED_KEY) return { ok: false, reason: "fred key missing" };
  const url =
    "https://api.stlouisfed.org/fred/series/observations?file_type=json";
  try {
    const { data } = await axios.get(url, {
      params: { series_id: seriesId, api_key: FRED_KEY },
      timeout: 12000,
      headers: { "User-Agent": UA },
    });
    const rows = data?.observations || [];
    if (!rows.length) return { ok: false, reason: "fred empty" };
    const last = lastNonEmptyFred(rows);
    if (!last) return { ok: false, reason: "fred no last" };
    // 找上一筆有效值計算 % 變化
    let prev = null;
    for (let i = rows.length - 2; i >= 0; i--) {
      const v = Number(rows[i]?.value);
      if (Number.isFinite(v)) {
        prev = v;
        break;
      }
    }
    return {
      ok: true,
      close: Number(last.value),
      pct: Number.isFinite(prev) ? pct(Number(last.value), prev) : null,
      date: last.date,
    };
  } catch (e) {
    return { ok: false, reason: e?.message || "fred error" };
  }
}

// ---------- Stooq（第一層；常不穩，只當試水溫） ----------
async function stooqBatch(symbols) {
  // symbols: 例如 ['^spx','^ndx','^dji','^vix','soxx.us','gld.us']
  const url = "https://stooq.com/q/l/";
  try {
    const { data } = await axios.get(url, {
      params: { s: symbols.join(","), i: "d" },
      timeout: 8000,
      headers: { "User-Agent": UA, Referer: "https://stooq.com/" },
      responseType: "text",
    });
    // CSV header: Symbol,Date,Time,Open,High,Low,Close,Volume
    const lines = String(data).trim().split(/\r?\n/);
    const out = {};
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const sym = cols[0]?.trim();
      const close = Number(cols[6]);
      if (sym) {
        out[sym] = {
          close: Number.isFinite(close) ? close : null,
          pct: null, // stooq 單日取不到昨收，% 留空
        };
      }
    }
    return { ok: true, map: out };
  } catch (e) {
    return { ok: false, reason: e?.message || "stooq error" };
  }
}

// ---------- 快照主流程 ----------
module.exports = function mountIntl(app) {
  // 白名單新聞：WSJ Markets
  app.get("/intl/news_headlines", async (req, res) => {
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || "10", 10)));
    const feedUrl = "https://feeds.a.dj.com/rss/RSSMarketsMain.xml";
    try {
      const feed = await parser.parseURL(feedUrl);
      const items = (feed?.items || []).slice(0, limit).map((it) => ({
        title: it.title || "",
        source: "WSJ.com: Markets",
        url: it.link || "",
        published_at: it.isoDate || it.pubDate || "",
      }));
      res.json({ items });
    } catch (e) {
      res.status(502).json({ items: [], error: e?.message || "rss error" });
    }
  });

  // 國際盤快照（含多層備援 / ?alpha=1 可強制走 Alpha）
  app.get("/intl/market_snapshot", async (req, res) => {
    const notes = [];
    const out = {
      date: isoDate(),
      spx: { close: null, pct: null },
      ndx: { close: null, pct: null },
      dji: { close: null, pct: null },
      sox: { close: null, pct: null },
      vix: { close: null, pct: null },
      dxy: { close: null, pct: null },
      us10y: { close: null, pct: null },
      wti: { close: null, pct: null },
      brent: { close: null, pct: null },
      gold: { close: null, pct: null },
      notes,
    };

    const forceAlpha = String(req.query.alpha || "").trim() === "1";

    // ---- 宏觀：先試 FRED（穩定） ----
    // DXY ≈ DTWEXM（名義美元指數-主要貨幣）
    if (FRED_KEY) {
      const fredMap = {
        dxy: "DTWEXM",
        us10y: "DGS10",
        wti: "DCOILWTICO",
        brent: "DCOILBRENTEU",
      };
      for (const [k, series] of Object.entries(fredMap)) {
        try {
          const r = await fredSeries(series);
          if (r.ok) {
            out[k].close = r.close;
            out[k].pct = r.pct;
          } else {
            notes.push(`fred ${series} failed`);
          }
        } catch {
          notes.push(`fred ${series} failed`);
        }
      }

      // Gold 先試 FRED 的 London Fix（AM/PM），之後再用 Alpha GLD 補
      for (const series of ["GOLDAMGBD228NLBM", "GOLDPMGBD228NLBM"]) {
        if (out.gold.close != null) break;
        try {
          const r = await fredSeries(series);
          if (r.ok) {
            out.gold.close = r.close;
            out.gold.pct = r.pct;
          } else {
            notes.push(`fred ${series} failed`);
          }
        } catch {
          notes.push(`fred ${series} failed`);
        }
      }
    }

    // ---- 指數（第一層：Stooq），僅試水溫，失敗就讓 Alpha 接手 ----
    const stooqSyms = ["^spx", "^ndx", "^dji", "^vix", "soxx.us", "gld.us"];
    if (!forceAlpha) {
      try {
        const r = await stooqBatch(stooqSyms);
        if (r.ok && r.map) {
          const m = r.map;
          if (m["^spx"]?.close != null) out.spx.close = m["^spx"].close;
          else notes.push("stooq ^spx failed");
          if (m["^ndx"]?.close != null) out.ndx.close = m["^ndx"].close;
          else notes.push("stooq ^ndx failed");
          if (m["^dji"]?.close != null) out.dji.close = m["^dji"].close;
          else notes.push("stooq ^dji failed");
          if (m["^vix"]?.close != null) out.vix.close = m["^vix"].close;
          else notes.push("stooq ^vix failed");
          if (m["soxx.us"]?.close != null) out.sox.close = m["soxx.us"].close;
          else notes.push("stooq soxx.us failed");
          if (m["gld.us"]?.close != null && out.gold.close == null)
            out.gold.close = m["gld.us"].close;
          else if (out.gold.close == null) notes.push("stooq gld.us failed");
        } else {
          notes.push("stooq batch failed");
        }
      } catch {
        notes.push("stooq batch error");
      }
    } else {
      notes.push("force alpha=1");
    }

    // ---- 第二/三層：Alpha Vantage（ETF 代理）補齊 close 與 pct ----
    // 映射：SPX→SPY, NDX→QQQ, DJI→DIA, SOX→SOXX, VIX→VIXY, GOLD→GLD
    const alphaMap = [
      ["spx", "SPY"],
      ["ndx", "QQQ"],
      ["dji", "DIA"],
      ["sox", "SOXX"],
      ["vix", "VIXY"],
    ];
    for (const [key, sym] of alphaMap) {
      if (forceAlpha || out[key].close == null || out[key].pct == null) {
        const r = await alphaGlobalQuote(sym);
        if (r.ok) {
          out[key].close = r.close;
          out[key].pct = r.pct;
          notes.push(`${key} via AlphaVantage ${sym}`);
        } else {
          notes.push(`alpha ${key} ${sym} ${r.reason || "failed"}`);
        }
      }
    }
    if (out.gold.close == null || out.gold.pct == null) {
      const gr = await alphaGlobalQuote("GLD");
      if (gr.ok) {
        out.gold.close = gr.close;
        out.gold.pct = gr.pct;
        notes.push("gold via AlphaVantage GLD");
      } else {
        notes.push(`alpha gold GLD ${gr.reason || "failed"}`);
      }
    }

    res.json(out);
  });
};
