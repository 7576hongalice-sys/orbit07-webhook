import fetch from 'node-fetch';

// 你的 repo 的 raw 路徑（分支是 main）
const RAW_BASE = 'https://raw.githubusercontent.com/7576hongalice-sys/orbit07-webhook/main/content';

// 讀取 content/*.txt 的小工具
async function pull(name) {
  try {
    const r = await fetch(`${RAW_BASE}/${name}.txt`, { cache: 'no-store' });
    if (!r.ok) throw new Error('fetch fail');
    const t = (await r.text()).trim();
    return t || `(${name} 還沒有內容)`;
  } catch (e) {
    return `(${name} 讀取失敗，請稍後再試)`;
  }
}

// 給 index.js 用的三個出口
export async function preOpen()   { return await pull('preopen'); }
export async function noonBrief() { return await pull('noon'); }
export async function closeWrap() { return await pull('close'); }
