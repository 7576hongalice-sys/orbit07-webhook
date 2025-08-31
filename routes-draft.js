// routes-draft.js — Draft composer for "盤前導航" (Markdown, with scoring)
const axios = require('axios');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const fmtNum = (v, d=2) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : (typeof v === 'number' ? v.toFixed(d) : v);
const fmtPct = (p) => (p === null || p === undefined || Number.isNaN(p)) ? '—' : `${p>=0?'+':''}${p.toFixed(2)}%`;
const lineKV = (emoji, label, value)=> `${emoji} **${label}**：${value}`;

function makeIntlBlock(intl, newsItems){
  const L = [], parts = [];
  if (intl?.spx)  parts.push(`S&P500 ${fmtNum(intl.spx.close,2)} (${fmtPct(intl.spx.pct)})`);
  if (intl?.ndx)  parts.push(`Nasdaq ${fmtNum(intl.ndx.close,2)} (${fmtPct(intl.ndx.pct)})`);
  if (intl?.dji)  parts.push(`道瓊 ${fmtNum(intl.dji.close,2)} (${fmtPct(intl.dji.pct)})`);
  if (intl?.sox)  parts.push(`費半 ${fmtNum(intl.sox.close,2)} (${fmtPct(intl.sox.pct)})`);
  if (intl?.vix)  parts.push(`VIX ${fmtNum(intl.vix.close,2)} (${fmtPct(intl.vix.pct)})`);
  if (intl?.dxy)  parts.push(`美元指數 ${fmtNum(intl.dxy.close,2)} (${fmtPct(intl.dxy.pct)})`);
  if (intl?.us10y)parts.push(`美10Y ${fmtNum(intl.us10y.close,2)}%`);
  if (intl?.wti)  parts.push(`WTI ${fmtNum(intl.wti.close,2)} (${fmtPct(intl.wti.pct)})`);
  if (intl?.brent)parts.push(`Brent ${fmtNum(intl.brent.close,2)} (${fmtPct(intl.brent.pct)})`);
  if (intl?.gold) parts.push(`Gold ${fmtNum(intl.gold.close,2)} (${fmtPct(intl.gold.pct)})`);
  L.push(lineKV('🌍','國際盤與新聞重點', parts.length ? parts.join('｜') : '缺：國際盤'));

  if (newsItems?.length){
    const top = newsItems.slice(0,3).map(it=> `- ${it.title} 〔${it.source||'news'}〕`);
    L.push(top.join('\n'));
  } else {
    L.push('- 缺：國際財經新聞');
  }
  return L.join('\n');
}

function makeTableSection(title, rows){
  const header = ['代號','名稱','參考收盤','VWAP','關鍵價','低接區','停損','目標一','目標二','預測狀態','策略建議','備註'];
  const lines = [];
  lines.push(`### ${title}`);
  lines.push(header.join('｜'));
  lines.push(header.map(()=>':--').join('｜'));
  for (const r of rows){
    lines.push([
      r.code||'—',
      r.name||'—',
      r.refClose!=null? fmtNum(r.refClose,2) : '—',
      r.vwap || '—',
      r.key  ?? '—',
      r.bid  ?? '—',
      r.stop ?? '—',
      r.t1   ?? '—',
      r.t2   ?? '—',
      r.state|| '—',
      r.plan || '—',
      r.note || '—'
    ].join('｜'));
  }
  return lines.join('\n');
}

module.exports = function mountDraft(app){
  // GET /draft/morning?news=5&only=self|mom|all
  app.get('/draft/morning', async (req, res)=>{
    const base = `${req.protocol}://${req.get('host')}`;
    const newsN = Math.max(1, Math.min(Number(req.query.news||5), 10));
    const only  = (req.query.only||'all').toLowerCase();

    const out = { ok:true, date: new Date().toISOString().slice(0,10), markdown: '', notes: [] };

    try {
      // 1) 拉 watchlist / intl / news
      const [watch, intl, news] = await Promise.all([
        axios.get(`${base}/watchlist`, { headers:{'User-Agent':UA} }).then(r=>r.data).catch(()=>null),
        axios.get(`${base}/intl/market_snapshot`, { headers:{'User-Agent':UA} }).then(r=>r.data).catch(()=>null),
        axios.get(`${base}/intl/news_headlines?limit=${newsN}`, { headers:{'User-Agent':UA} }).then(r=>r.data).catch(()=>null),
      ]);

      const self = Array.isArray(watch?.self) ? watch.self : [];
      const mom  = Array.isArray(watch?.mom)  ? watch.mom  : [];
      if (!watch) out.notes.push('缺：watchlist');
      if (!intl)  out.notes.push('缺：intl/market_snapshot');
      if (!news)  out.notes.push('缺：intl/news_headlines');

      // 2) 要評分的代號
      let codes = [];
      if (only === 'self') codes = self.map(x=>x.code);
      else if (only === 'mom') codes = mom.map(x=>x.code);
      else codes = [...self.map(x=>x.code), ...mom.map(x=>x.code)];
      codes = Array.from(new Set(codes.filter(Boolean)));

      // 3) 拉 confluence score（含建議四價）
      let scoreMap = new Map();
      if (codes.length){
        try{
          const sc = await axios.get(`${base}/score/confluence?codes=${encodeURIComponent(codes.join(','))}`, { headers:{'User-Agent':UA} }).then(r=>r.data);
          scoreMap = new Map((sc?.items||[]).map(it=> [it.code, it]));
        }catch{ out.notes.push('缺：score/confluence'); }
      }

      // 4) 組 rows
      const toRow = (it)=>{
        const s = scoreMap.get(it.code);
        return {
          code: it.code,
          name: it.name || s?.name || '',
          refClose: s?.refClose ?? null,
          vwap:'—',
          key:  s?.suggestion?.key ?? '—',
          bid:  s?.suggestion?.bid ?? '—',
          stop: s?.suggestion?.stop ?? '—',
          t1:   s?.suggestion?.t1 ?? '—',
          t2:   s?.suggestion?.t2 ?? '—',
          state: s?.suggestion?.bias || '—',
          plan:  s?.suggestion?.plan || '—',
          note:  s ? `score ${s.score}/100｜${s.suggestion?.note||''}` : '—'
        };
      };
      const rowsSelf = self.map(toRow);
      const rowsMom  = mom.map(toRow);

      // 5) Markdown 輸出（固定模板＋小圖示）
      const mdParts = [];
      mdParts.push('## 盤前導航 × 總覽');
      mdParts.push(makeIntlBlock(intl, news?.items));
      mdParts.push(lineKV('🏦','三大法人買賣超（昨）','缺：外資／投信／自營商'));
      mdParts.push(lineKV('🧪','戀股主場 × 五大模組共振','已整合：趨勢/動能/量能/法人/宏觀（分數含於各股備註）'));
      mdParts.push(lineKV('🧭','操作建議導航','倉位：—｜題材：—｜關鍵價：—｜風控：—'));
      mdParts.push(lineKV('⚠️','開盤注意事項','- —'));

      mdParts.push('\n## 個股預言 × 四價表');
      if (rowsSelf.length) mdParts.push(makeTableSection('① 使用者追蹤', rowsSelf));
      else mdParts.push('（缺：使用者追蹤清單）');
      if (rowsMom.length)  mdParts.push(makeTableSection('② 媽媽追蹤（必分析）', rowsMom));
      else mdParts.push('（缺：媽媽追蹤清單）');

      mdParts.push('\n> ⚠️ 非投資建議');
      out.markdown = mdParts.join('\n\n');
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ ok:false, error: String(e?.message||e) });
    }
  });
};
