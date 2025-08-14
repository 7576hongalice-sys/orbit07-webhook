export async function preOpen() {
  // 之後會接你的盤前模板
  return '〔盤前預言〕今天區間震盪，電子偏強、金融觀察量能。';
}

export async function noonBrief() {
  return '〔午盤小結〕量能平穩，AI 族群續表態，留意尾盤拉抬/回吐。';
}

export async function closeWrap() {
  // 之後替換成實際收盤數據摘要
  return '〔收盤總結〕加權平收、成交量略增，電子>傳產>金融。';
}
