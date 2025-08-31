// routes-lists.js — watchlist (Gist or local) + symbols lookup
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

const GIST_TOKEN    = process.env.GIST_TOKEN || '';
const GIST_ID       = process.env.GIST_ID || '';
const GIST_FILENAME = process.env.GIST_FILENAME || '';
const LISTS_PATH    = process.env.LISTS_PATH || './data/lists.json';
const SYMBOLS_PATH  = process.env.SYMBOLS_PATH || './symbols.json';
const CRON_KEY      = process.env.CRON_KEY || '';

const BASELINE = {
  self:[{code:'2374',name:'佳能'},{code:'2355',name:'敬鵬'},{code:'4958',name:'臻鼎-KY'},{code:'1409',name:'新纖'},{code:'5202',name:'力新'},{code:'2345',name:'富喬'},{code:'4526',name:'錦明'}],
  mom:[{code:'6274',name:'台燿'},{code:'3211',name:'順達'},{code:'6196',name:'帆宣'},{code:'2404',name:'漢科'},{code:'2402',name:'毅嘉'}],
  updatedAt: new Date(0).toISOString()
};

const normName = (s='') => s.toString().replace(/[()\s]/g,'').replace(/－/g,'-').replace(/-KY$/i,'').replace(/[Ａ-Ｚａ-ｚ０-９]/g,ch=>String.fromCharCode(ch.charCodeAt(0)-0xFEE0)).toUpperCase();

async function readLocalJSON(p){ try{ return JSON.parse(await fs.readFile(p,'utf8')); }catch{ return null; } }
async function writeLocalJSON(p,obj){ await fs.mkdir(path.dirname(p),{recursive:true}); await fs.writeFile(p,JSON.stringify(obj,null,2),'utf8'); }

async function readGistJSON(){
  if(!GIST_TOKEN||!GIST_ID||!GIST_FILENAME) return null;
  const r=await axios.get(`https://api.github.com/gists/${GIST_ID}`,{headers:{Authorization:`Bearer ${GIST_TOKEN}`},timeout:8000});
  const f=r.data?.files?.[GIST_FILENAME]; if(!f) return null;
  if(f.raw_url){ const raw=await axios.get(f.raw_url,{headers:{Authorization:`Bearer ${GIST_TOKEN}`},timeout:8000}); try{return JSON.parse(raw.data);}catch{ return null; } }
  if(f.content){ try{return JSON.parse(f.content);}catch{ return null; } }
  return null;
}
async function writeGistJSON(obj){
  if(!GIST_TOKEN||!GIST_ID||!GIST_FILENAME) return false;
  await axios.patch(`https://api.github.com/gists/${GIST_ID}`,{files:{[GIST_FILENAME]:{content:JSON.stringify(obj,null,2)}}},{headers:{Authorization:`Bearer ${GIST_TOKEN}`,'Content-Type':'application/json'},timeout:8000});
  return true;
}
async function loadWatchlist(){ return (await readGistJSON()) || (await readLocalJSON(LISTS_PATH)) || BASELINE; }
async function saveWatchlist(obj){ obj.updatedAt=new Date().toISOString(); const ok=await writeGistJSON(obj); if(!ok) await writeLocalJSON(LISTS_PATH,obj); return obj; }

async function loadSymbols(){ return await readLocalJSON(SYMBOLS_PATH); }
async function saveSymbols(map){ await writeLocalJSON(SYMBOLS_PATH,map); return map; }

module.exports = function mountLists(app){
  app.get('/watchlist', async (_req,res)=>{
    const wl=await loadWatchlist();
    res.json({ self: wl.self||[], mom: wl.mom||[], updatedAt: wl.updatedAt||null });
  });

  app.post('/watchlist', async (req,res)=>{
    if(!CRON_KEY || req.header('x-webhook-key')!==CRON_KEY) return res.status(403).json({error:'forbidden'});
    const { list, action, code, name } = req.body || {};
    if(!['self','mom'].includes(list) || !['add','remove'].includes(action)) return res.status(400).json({error:'bad_request'});

    let wl=await loadWatchlist(); wl.self=wl.self||[]; wl.mom=wl.mom||[];
    const arr=wl[list];

    if(action==='add'){
      let c=code, n=name;
      if((!c || !/^\d{4}$/.test(c)) && name){
        try{
          const sy=await loadSymbols(); const NN=normName(name); const cand=[];
          if(sy?.byName?.[NN]) cand.push(...sy.byName[NN]);
          for(const [k,v] of Object.entries(sy?.byCode||{})){ if(normName(v).includes(NN)) cand.push(k); }
          if(cand.length){ c=cand[0]; n=sy.byCode[c]||name; }
        }catch{}
      }
      if(!c || !/^\d{4}$/.test(c)) return res.status(400).json({error:'need_code_or_resolvable_name'});
      if(!arr.find(x=>x.code===c)) arr.push({ code:c, name:n||'' });
    }else{
      if(!/^\d{4}$/.test(code||'')) return res.status(400).json({error:'need_code'});
      const i=arr.findIndex(x=>x.code===code); if(i>=0) arr.splice(i,1);
    }
    wl=await saveWatchlist(wl);
    res.json({ ok:true, self: wl.self, mom: wl.mom, updatedAt: wl.updatedAt });
  });

  app.get('/symbols/lookup', async (req,res)=>{
    const q=(req.query.q||'').toString().trim(); const sy=await loadSymbols();
    if(!q || !sy) return res.json({ matches: [] });
    const n=normName(q); const out=new Map();
    if(/^\d{4}$/.test(q) && sy.byCode[q]) out.set(q, sy.byCode[q]);
    (sy.byName?.[n]||[]).forEach(c=> out.set(c, sy.byCode[c]||''));
    for(const [c, nm] of Object.entries(sy.byCode)){ if(normName(nm).includes(n)) out.set(c, nm); }
    res.json({ matches: Array.from(out.entries()).slice(0,10).map(([code,name])=>({code,name})) });
  });

  app.post('/symbols/refresh', async (req,res)=>{
    if(!CRON_KEY || req.header('x-webhook-key')!==CRON_KEY) return res.status(403).json({error:'forbidden'});
    try{
      const r=await axios.get('https://api.finmindtrade.com/api/v4/data',{ params:{ dataset:'TaiwanStockInfo' }, timeout:12000 });
      const rows=r.data?.data||[]; const byCode={}, byName={};
      for(const it of rows){
        const code=it.stock_id, name=it.stock_name;
        if(!/^\d{4}$/.test(code)||!name) continue;
        byCode[code]=name;
        const nn=normName(name);
        byName[nn]=byName[nn]||[];
        if(!byName[nn].includes(code)) byName[nn].push(code);
      }
      await saveSymbols({ byCode, byName, updatedAt: new Date().toISOString(), count: Object.keys(byCode).length });
      res.json({ ok:true, count:Object.keys(byCode).length });
    }catch(e){ res.status(502).json({ error:'source_unavailable', detail:e?.message||e }); }
  });
};
