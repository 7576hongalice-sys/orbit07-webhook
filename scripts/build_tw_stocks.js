// scripts/build_tw_stocks.js
// 產生 data/tw_stocks.json（上市 + 盡力抓上櫃）；Node 18+（原生 fetch）
// 用法：npm run build:stocks

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data", "tw_stocks.json");
const EXTRA = path.join(__dirname, "..", "data", "aliases.extra.json"); // 可選

function normName(s = "") {
  return s.replace(/臺/g, "台")
          .replace(/股份有限公司|有限公司|公司/g, "")
          .replace(/\s+/g, "")
          .trim();
}
const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

async function fetchTWSE() {
  // TWSE ISIN 公開頁（HTML），用正則抽出 代號＋名稱
  const url = "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2";
  const r = await fetch(url, { headers: { "cache-control": "no-cache" } });
  const html = await r.text();
  const out = [];
  const re = />(\d{4}[A-Z]?)\s+([^<\s][^<]+)</g; // 例如「2330 台積電」
  let m;
  while ((m = re.exec(html))) {
    const code = m[1].toUpperCase();
    const nameRaw = m[2].trim();
    // 排除非普通股（指數、債、受益、權證、牛熊…）
    if (/指數|受益|債|購|售|牛|熊|特別股|存託憑證/.test(nameRaw)) continue;
    out.push({ code, name: normName(nameRaw), market: "TWSE" });
  }
  return out;
}

async function fetchTPEX() {
  // 有時 API 會限流；這裡先喚醒站台，避免 403
  try { await fetch("https://www.tpex.org.tw/www/zh-tw/", { method: "GET" }); } catch {}
  // 若你有固定 JSON/CSV 端點，可替換以下邏輯；這裡保守回空，避免部署失敗
  return [];
}

async function loadExtraAliases() {
  try {
    const txt = await fs.readFile(EXTRA, "utf8");
    return JSON.parse(txt || "{}");
  } catch {
    return {};
  }
}

async function main() {
  console.log("⌛ 下載官方名單…");
  const [twse, tpex] = await Promise.allSettled([fetchTWSE(), fetchTPEX()]);
  const listTWSE = twse.status === "fulfilled" ? twse.value : [];
  const listTPEX = tpex.status === "fulfilled" ? tpex.value : [];
  const raw = [...listTWSE, ...listTPEX];

  // 依代號去重
  const byCode = new Map();
  for (const it of raw) if (!byCode.has(it.code)) byCode.set(it.code, it);

  // 併入自訂別名
  const aliases = await loadExtraAliases();
  const list = Array.from(byCode.values()).map(it => ({
    code: it.code,
    name: it.name,
    alias: uniq(aliases[it.code])
  }));

  // 依代號排序
  list.sort((a, b) => a.code.localeCompare(b.code, "zh-Hant"));

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(list, null, 2), "utf8");
  console.log(`✅ 產生 ${list.length} 檔 → ${OUT}`);
}

main().catch(e => {
  console.error("❌ build_tw_stocks 失敗:", e);
  process.exit(1);
});
