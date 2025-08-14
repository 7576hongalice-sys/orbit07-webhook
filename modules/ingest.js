// modules/ingest.js
export function makePreopenFromRaw(raw) {
  const d = new Date();
  const date = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;

  const pick = (label) => {
    const re = new RegExp(`${label}[:：]\\s*([\\s\\S]*?)(?=\\n#|$)`);
    const m = raw.match(re);
    return (m?.[1] || '').trim();
  };

  const card   = pick('#預言卡') || pick('預言卡');
  const news   = pick('#國際盤') || pick('#國際盤與新聞') || '';
  const legal  = pick('#法人') || '';
  const mods   = pick('#五大模組') || pick('#共振') || '';
  const watch  = pick('#追蹤股') || '';
  const guide  = pick('#操作導航') || pick('#操作建議') || '';
  const alert  = pick('#開盤注意') || pick('#注意事項') || '';

  const fallback = raw.trim();

  return `📅 ${date} 戀股主場 × 盤前預言 + 導航

🔮 盤前預言卡（可對帳）
${card || '—'}

🌐 國際盤與新聞重點
${news || '—'}

🏦 三大法人（昨）
${legal || '—'}

💖 戀股主場 × 五大模組共振
${mods || '—'}

📌 你的追蹤股與操作建議
${watch || '—'}

📝 操作建議導航
${guide || (fallback ? fallback : '—')}

🚨 開盤注意事項
${alert || '—'}`;
}
