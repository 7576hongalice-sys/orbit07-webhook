import fs from 'fs/promises';
const FILE = './today_forecast.txt'; // Render 可寫本地暫存檔

export async function saveForecast(text) {
  await fs.writeFile(FILE, text || '', 'utf8');
}

export async function compareWithClose(actual) {
  let pred = '';
  try { pred = await fs.readFile(FILE, 'utf8'); } catch {}
  if (!pred) return `今天沒有盤前預言紀錄\n收盤：「${actual}」`;
  // 簡單規則：都提「震盪」就算命中；之後可擴充成方向/幅度比對
  const hit = actual.includes('震盪') && pred.includes('震盪');
  return `盤前：「${pred}」\n收盤：「${actual}」\n結果：${hit ? '命中 ✅' : '未命中 ❌'}`;
}
