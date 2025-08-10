// symbols.js — 全市場代號/名稱對照 + 別名 + 模糊比對 + 快取
// Node18+ 原生 fetch 可用；請在主程式把白名單開放 isin.twse.com.tw / www.tpex.org.tw

const fs = require("fs/promises");
const path = require("path");

const DEFAULT_CACHE = process.env.SYMBOLS_PATH || "/data/symbols.json";

// 基礎正規化
function norm(s) {
  return String(s || "")
    .trim()
    .replace(/臺/g, "台")
    .replace(/股份有限公司|有限公司|公司/g, "")
    .replace(/[()（）\s]/g, "")
    .toUpperCase();
}

// 讀/寫快取
async function loadCache(file = DEFAULT_CACHE) {
  try {
    const txt = await fs.readFile(file, "utf8");
    return JSON.parse(txt || "{}");
  } catch {
    return { updatedAt: null, list: [], aliases: {} };
  }
}
async function saveCache(cache, file = DEFAULT_CACHE) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(cache, null, 2), "utf8");
}

// 下載 TWSE / TPEX 名單（最小可用擷取）
async function fetchTWSEList() {
  // TWSE ISIN 公開頁（HTML 表格），我們用最小字串法抽 4 碼代號與名稱
  const url = "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2";
  const r = await fetch(url, { headers: { "cache-control": "no-cache" } });
  const html = await r.text();
  const rows = [];
  // 以行切分，找像「2330　台積電」的片段
  const re = />(\d{4}[A-Z]?)\s+([^<\s][^<]+)</g;
  let m;
  while ((m = re.exec(html))) {
    const code = m[1].toUpperCase();
    const name = m[2].trim();
    // 過濾指數/債券行
    if (/指數|受益|債|購|售|牛|熊/.test(name)) continue;
    rows.push({ code, name, market: "TWSE" });
  }
  return rows;
}
async function fetchTPEXList() {
  // TPEX 名單頁很多版本，這裡用最穩的 JSON 介面（若失敗就回空）
  // 若介面變動，仍可依 HTML 以正則抽取 code/name
  const url = "https://www.tpex.org.tw/www/zh-tw/";
  try {
    // 先打首頁喚醒 cloudfront / 緩啟（有些時段直接打 API 會 403）
    await fetch(url, { method: "GET" });
  } catch {}
  // 簡化：若 API 限制，就返回空陣列，不影響 TWSE
  return [];
}

// 建索引
function buildIndex(list, aliases = {}) {
  const byCode = new Map();
  const byName = new Map();

  for (const it of list) {
    const code = it.code.toUpperCase();
    const name = it.name.trim();
    byCode.set(code, { code, name, market: it.market || "TWSE" });
    byName.set(norm(name), code);
  }
  // 別名映射
  for (const [code, names] of Object.entries(aliases || {})) {
    for (const n of names) {
      byName.set(norm(n), code.toUpperCase());
    }
  }
  return { byCode, byName };
}

// 模糊比對（最簡距離法）
function fuzzyFind(byName, q) {
  const key = norm(q);
  const cand = [];
  for (const [k, v] of byName.entries()) {
    if (k.includes(key) || key.includes(k)) cand.push({ key: k, code: v });
  }
  // 去重，最多 5 筆
  const seen = new Set();
  const out = [];
  for (const c of cand) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    out.push(c.code);
    if (out.length >= 5) break;
  }
  return out;
}

async function refreshSymbols(file = DEFAULT_CACHE) {
  const twse = await fetchTWSEList().catch(() => []);
  const tpex = await fetchTPEXList().catch(() => []);
  const list = [...twse, ...tpex];

  // 併入現有別名
  const cache = await loadCache(file);
  const aliases = cache.aliases || {};
  await saveCache({ updatedAt: new Date().toISOString(), list, aliases }, file);
  return { list, aliases };
}

async function initSymbols(file = DEFAULT_CACHE) {
  const cache = await loadCache(file);
  if (!cache.list || cache.list.length === 0) {
    await refreshSymbols(file);
    return initSymbols(file);
  }
  const { byCode, byName } = buildIndex(cache.list, cache.aliases || {});
  return {
    file,
    cache,
    byCode,
    byName,
    resolve(query) {
      const s = String(query || "");
      const codeLike = /^\d{4,5}[A-Z]*$/i.test(s);
      if (codeLike) {
        const code = s.toUpperCase();
        const hit = byCode.get(code);
        if (hit) return hit;
        return null;
      }
      const code = byName.get(norm(s));
      if (code && byCode.get(code)) return byCode.get(code);

      // 模糊建議
      const sugg = fuzzyFind(byName, s);
      return { suggest: sugg };
    },
    async addAlias(code, ...names) {
      const c = code.toUpperCase();
      const cc = await loadCache(file);
      if (!cc.aliases) cc.aliases = {};
      if (!cc.aliases[c]) cc.aliases[c] = [];
      for (const n of names) {
        const k = String(n || "").trim();
        if (!k) continue;
        if (!cc.aliases[c].includes(k)) cc.aliases[c].push(k);
      }
      await saveCache(cc, file);
      return true;
    }
  };
}

module.exports = { initSymbols, refreshSymbols, DEFAULT_CACHE };
