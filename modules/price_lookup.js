export async function priceLookup(q) {
  if (!q) return '用法：/p 代號，例如 /p 2330';
  // 之後接真實行情資料來源
  return `查價 ${q}：現價 123.45（+1.2%），量 10,000。`;
}
