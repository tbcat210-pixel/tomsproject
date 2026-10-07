const state={data:null,window:'12h',query:'',min:0,sources:null,sourcesOpen:false,sourceLimit:100,sourceCard:null};
const $=s=>document.querySelector(s);
const fmt=n=>new Intl.NumberFormat('ja-JP').format(n??0);
const dt=s=>s?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(s)):'—';
const span=(a,b)=>{if(!a||!b)return '未取得';const h=Math.max(0,(new Date(b)-new Date(a))/36e5);return h<48?`${Math.round(h)}時間`:`${(h/24).toFixed(1)}日`;};

const LIVE_DATA_URL='https://raw.githubusercontent.com/tbcat210-pixel/tomsproject/main/docs/data/rankings.json';
const LIVE_POSTS_URL='https://raw.githubusercontent.com/tbcat210-pixel/tomsproject/main/.collector-data/posts.json';

async function fetchRankings(){
  const urls=[
    `${LIVE_DATA_URL}?t=${Date.now()}`,
    `./data/rankings.json?t=${Date.now()}`
  ];
  let lastError=null;
  for(const url of urls){
    try{
      const res=await fetch(url,{cache:'no-store'});
      if(!res.ok)throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }catch(e){
      lastError=e;
    }
  }
  throw lastError ?? new Error('ranking data unavailable');
}

async function fetchSourcePosts(){
  const res=await fetch(`${LIVE_POSTS_URL}?t=${Date.now()}`,{cache:'no-store'});
  if(!res.ok)throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function ensureSources(){
  if(state.sources){
    renderSources();
    return;
  }
  const status=$('#sourceStatus');
  status.textContent='参照元を読み込み中…';
  try{
    state.sources=await fetchSourcePosts();
    status.textContent='';
    renderSources();
  }catch(e){
    status.textContent='参照元ポストを読み込めませんでした。しばらくしてから再度お試しください。';
    console.error(e);
  }
}

function getVisibleSources(){
  if(!state.data||!state.sources)return [];
  const windowData=state.data.windows[state.window];
  const end=new Date(state.data.generatedAt).getTime();
  const start=end-windowData.hours*3600_000;
  const q=state.query.trim().toLowerCase();
  const selectedCard=state.sourceCard;
  const unique=new Map();

  for(const post of state.sources){
    if(!post?.id||!post?.createdAt)continue;
    const t=new Date(post.createdAt).getTime();
    if(!Number.isFinite(t)||t<start||t>end+3600_000)continue;

    const demand=Array.isArray(post.demand)?post.demand:[];
    const supply=Array.isArray(post.supply)?post.supply:[];
    const all=[...demand,...supply];

    if(selectedCard){
      if(!all.some(name=>String(name)===selectedCard))continue;
    }else if(q&& !all.some(name=>String(name).toLowerCase().includes(q))){
      continue;
    }

    const id=String(post.id);
    if(!unique.has(id)){
      unique.set(id,{id,createdAt:post.createdAt,demand:new Set(demand),supply:new Set(supply)});
    }else{
      const item=unique.get(id);
      demand.forEach(name=>item.demand.add(name));
      supply.forEach(name=>item.supply.add(name));
    }
  }

  return [...unique.values()].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
}

function renderSources(){
  if(!state.sourcesOpen||!state.sources)return;
  const posts=getVisibleSources();
  const shown=posts.slice(0,state.sourceLimit);
  $('#sourcesTitle').textContent=state.sourceCard?`${state.sourceCard} の参照元ポスト`:'参照元ポスト';
  $('#sourcesDescription').textContent=state.sourceCard
    ? `現在選択中の${state.data.windows[state.window].label}に「${state.sourceCard}」が求または譲として含まれた公開Xポストです。`
    : '現在選択中の期間にランキング集計へ使われた公開Xポストへのリンクです。カード名検索にも連動し、同じ投稿IDは1件にまとめます。';
  $('#sourceCount').textContent=`${fmt(posts.length)}件（投稿ID重複除外）`;
  $('#sourceList').innerHTML=shown.map(post=>{
    const demand=[...post.demand].map(x=>escapeHtml(String(x))).join('、')||'—';
    const supply=[...post.supply].map(x=>escapeHtml(String(x))).join('、')||'—';
    const url=`https://x.com/i/web/status/${encodeURIComponent(post.id)}`;
    return `<li class="source-item">
      <div class="source-item-main">
        <time datetime="${escapeHtml(post.createdAt)}">${escapeHtml(dt(post.createdAt))} JST</time>
        <div class="source-tags"><span><b>求</b> ${demand}</span><span><b>譲</b> ${supply}</span></div>
      </div>
      <a class="source-link" href="${url}" target="_blank" rel="noopener noreferrer nofollow">Xの元ポストを開く ↗</a>
    </li>`;
  }).join('');
  $('#sourceEmpty').hidden=posts.length>0;
  const more=$('#moreSources');
  more.hidden=shown.length>=posts.length;
  more.textContent=`さらに表示（残り ${fmt(posts.length-shown.length)}件）`;
}

async function load(){
  try{
    state.data=await fetchRankings();
    if(!state.data.windows?.[state.window]){
      state.window=state.data.windows?.['24h']?'24h':Object.keys(state.data.windows??{})[0];
      document.querySelectorAll('[data-window]').forEach(x=>x.classList.toggle('active',x.dataset.window===state.window));
    }
    $('#updated').textContent=dt(state.data.generatedAt)+' JST';
    $('#storedPosts').textContent=fmt(state.data.coverage.storedPosts);
    $('#cardCount').textContent=fmt(state.data.cards.count);
    $('#coverage').textContent=span(state.data.coverage.oldestPostAt,state.data.coverage.newestPostAt);
    const h=state.data.coverage.history;
    const historyEl=$('#historyStatus');
    if(h){
      const status=h.completeWithinSearchResults?'7日遡及済み':'7日遡及・一部上限';
      historyEl.textContent=status;
      historyEl.title=`最終遡及: ${dt(h.completedAt)} / 成功 ${h.queriesSucceeded}/${h.queriesAttempted} / 上限到達 ${h.queriesCapped}`;
    }else{
      historyEl.textContent='初回遡及待ち';
    }
    const o=state.data.coverage.imageOcr;
    const ocrEl=$('#ocrStatus');
    if(o){
      ocrEl.textContent=`${fmt(o.postsFromImages ?? 0)}投稿`;
      ocrEl.title=`今回OCR: ${fmt(o.newImages ?? 0)}画像 / キャッシュ: ${fmt(o.cacheHits ?? 0)} / 失敗: ${fmt(o.failedImages ?? 0)} / OCRパス: ${fmt(o.candidatePasses ?? 0)}`;
    }else{
      ocrEl.textContent='有効';
    }
    $('#sourceNote').textContent=state.data.source.note;
    render();
  }catch(e){
    $('#updated').textContent='データ未取得';
    $('#sourceNote').textContent='GitHub上の最新ランキングデータを取得できませんでした。しばらくしてから再読み込みしてください。';
    console.error(e);
  }
}

function render(){
  if(!state.data)return;
  const w=state.data.windows[state.window];
  $('#periodTitle').textContent=`${w.label}ランキング`;
  $('#stats').innerHTML=`
    <article class="stat"><span>需要総数</span><strong>${fmt(w.totalDemand)}</strong><small>カード記載回数</small></article>
    <article class="stat"><span>供給総数</span><strong>${fmt(w.totalSupply)}</strong><small>カード記載回数</small></article>
    <article class="stat"><span>全体 需要/供給</span><strong>${w.totalRatio.ratioDisplay}</strong><small>高いほど不足寄り</small></article>
    <article class="stat"><span>解析投稿数</span><strong>${fmt(w.posts)}</strong><small>投稿ID重複排除後</small></article>`;

  const q=state.query.trim().toLowerCase();
  const rows=w.rankings
  .filter(x=>(!q||x.name.toLowerCase().includes(q))&&(x.demand+x.supply>=state.min))
  .sort((a,b)=>b.demand-a.demand||a.supply-b.supply||a.name.localeCompare(b.name,'ja'));
  const max=Math.max(1,...rows.map(x=>Math.max(x.demand,x.supply)));
  $('#ranking').innerHTML=rows.map((x,i)=>`<tr>
    <td class="rank">${i+1}</td><td class="card-name">${escapeHtml(x.name)}</td>
    <td class="need">${fmt(x.demand)}</td><td class="supply">${fmt(x.supply)}</td>
    <td class="ratio">${x.ratioDisplay}</td><td class="imbalance ${x.imbalance>0?'pos':x.imbalance<0?'neg':''}">${x.imbalance>0?'+':''}${fmt(x.imbalance)}</td>
    <td><div class="bars"><div class="bar needbar"><i style="width:${x.demand/max*100}%"></i></div><div class="bar supplybar"><i style="width:${x.supply/max*100}%"></i></div></div></td>
    <td class="source-cell"><button type="button" class="card-source-btn" data-card="${encodeURIComponent(x.name)}">参照元</button></td>
  </tr>`).join('');
  $('#empty').hidden=rows.length>0;
  if(state.sourcesOpen)renderSources();
}
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}

document.querySelectorAll('[data-window]').forEach(b=>b.addEventListener('click',()=>{if(!state.data?.windows?.[b.dataset.window])return;document.querySelectorAll('[data-window]').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.window=b.dataset.window;state.sourceLimit=100;render();}));
$('#search').addEventListener('input',e=>{state.query=e.target.value;state.sourceLimit=100;render();});
$('#minCount').addEventListener('change',e=>{state.min=Number(e.target.value);render();});
$('#toggleSources').addEventListener('click',async()=>{
  if(!state.sourcesOpen){
    state.sourceCard=null;
    state.sourceLimit=100;
  }
  state.sourcesOpen=!state.sourcesOpen;
  $('#sourcesBody').hidden=!state.sourcesOpen;
  $('#toggleSources').textContent=state.sourcesOpen?'一覧を閉じる':'一覧を表示';
  $('#toggleSources').setAttribute('aria-expanded',String(state.sourcesOpen));
  if(state.sourcesOpen)await ensureSources();
});
$('#ranking').addEventListener('click',async e=>{
  const button=e.target.closest('.card-source-btn');
  if(!button)return;
  state.sourceCard=decodeURIComponent(button.dataset.card);
  state.sourceLimit=100;
  state.sourcesOpen=true;
  $('#sourcesBody').hidden=false;
  $('#toggleSources').textContent='一覧を閉じる';
  $('#toggleSources').setAttribute('aria-expanded','true');
  await ensureSources();
  $('#sourcesTitle').scrollIntoView({behavior:'smooth',block:'start'});
});
$('#moreSources').addEventListener('click',()=>{state.sourceLimit+=100;renderSources();});
load();
setInterval(load,10*60*1000);
