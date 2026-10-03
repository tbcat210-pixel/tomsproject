const state={data:null,window:'24h',query:'',min:0};
const $=s=>document.querySelector(s);
const fmt=n=>new Intl.NumberFormat('ja-JP').format(n??0);
const dt=s=>s?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(s)):'—';
const span=(a,b)=>{if(!a||!b)return '未取得';const h=Math.max(0,(new Date(b)-new Date(a))/36e5);return h<48?`${Math.round(h)}時間`:`${(h/24).toFixed(1)}日`;};

async function load(){
  try{
    const res=await fetch(`./data/rankings.json?t=${Date.now()}`,{cache:'no-store'});
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    state.data=await res.json();
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
    $('#updated').textContent='データ未生成';
    $('#sourceNote').textContent='GitHub Actions の「Collect X trade data」を1回実行すると、現在より前の直近7日も遡って集計します。';
    console.error(e);
  }
}

function render(){
  const w=state.data.windows[state.window];
  $('#periodTitle').textContent=`${w.label}ランキング`;
  $('#stats').innerHTML=`
    <article class="stat"><span>需要総数</span><strong>${fmt(w.totalDemand)}</strong><small>カード記載回数</small></article>
    <article class="stat"><span>供給総数</span><strong>${fmt(w.totalSupply)}</strong><small>カード記載回数</small></article>
    <article class="stat"><span>全体 需要/供給</span><strong>${w.totalRatio.ratioDisplay}</strong><small>高いほど不足寄り</small></article>
    <article class="stat"><span>解析投稿数</span><strong>${fmt(w.posts)}</strong><small>投稿ID重複排除後</small></article>`;

  const q=state.query.trim().toLowerCase();
  const rows=w.rankings.filter(x=>(!q||x.name.toLowerCase().includes(q))&&(x.demand+x.supply>=state.min));
  const max=Math.max(1,...rows.map(x=>Math.max(x.demand,x.supply)));
  $('#ranking').innerHTML=rows.map((x,i)=>`<tr>
    <td class="rank">${i+1}</td><td class="card-name">${escapeHtml(x.name)}</td>
    <td class="need">${fmt(x.demand)}</td><td class="supply">${fmt(x.supply)}</td>
    <td class="ratio">${x.ratioDisplay}</td><td class="imbalance ${x.imbalance>0?'pos':x.imbalance<0?'neg':''}">${x.imbalance>0?'+':''}${fmt(x.imbalance)}</td>
    <td><div class="bars"><div class="bar needbar"><i style="width:${x.demand/max*100}%"></i></div><div class="bar supplybar"><i style="width:${x.supply/max*100}%"></i></div></div></td>
  </tr>`).join('');
  $('#empty').hidden=rows.length>0;
}
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}

document.querySelectorAll('[data-window]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-window]').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.window=b.dataset.window;render();}));
$('#search').addEventListener('input',e=>{state.query=e.target.value;render();});
$('#minCount').addEventListener('change',e=>{state.min=Number(e.target.value);render();});
load();
