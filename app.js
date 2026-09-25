const REGISTRY_URL='suppliers/suppliers.json';

let registry=null;
let storageWorker='';
let supplierConfigs=new Map();
let supplierBrands=new Map();
let selectedSuppliers=new Set();
let selectedBrands=new Set();

let activeSupplier=null;
let activeBrand=null;
let brandData=new Map();

let multiMode=false;
let multiRunning=false;

let tsoftData=null;
let aideData=null;
let unmatchedState=null;

const $=id=>document.getElementById(id);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rand=(base,jitter)=>base+Math.floor(Math.random()*(jitter||0));

const brandList=$('brand-list');
const supplierList=$('supplier-list');
const toolbar=$('toolbar');
const tableWrap=$('table-wrap');
const tbody=$('tbody');
const statusEl=$('status');
const notice=$('notice');

const DAYS=['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'];

function setStatus(s=''){
  statusEl.textContent=s;
}

function bar(id,n){
  const e=$(id);
  if(e)e.style.width=Math.max(0,Math.min(100,n))+'%';
}

function fmtFull(iso){
  if(!iso)return'';

  const d=new Date(iso);
  const today=new Date();
  const yest=new Date(today-86400000);

  const ds=d.toLocaleDateString('tr-TR');
  const ts=today.toLocaleDateString('tr-TR');
  const ys=yest.toLocaleDateString('tr-TR');

  const label=
    ds===ts?'Bugün':
    ds===ys?'Dün':
    `${ds} ${DAYS[d.getDay()]}`;

  return `${label} ${d.toLocaleTimeString('tr-TR',{
    hour:'2-digit',
    minute:'2-digit'
  })}`;
}

function normText(s){
  return String(s||'')
    .replace(/[ıİ]/g,'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[Øø]/g,'o')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,'');
}

function normCode(s){
  s=String(s||'').trim();

  const star=/^\*/.test(s)?'*':'';

  return star+
    normText(
      s.replace(/^\*/,'')
    ).toUpperCase();
}

function normDigits(s){
  return String(s||'')
    .replace(/\D/g,'')
    .replace(/^0+(?=\d)/,'');
}

function normalize(mode,v){
  return mode==='code'
    ?normCode(v)
    :mode==='digits'
      ?normDigits(v)
      :String(v||'').trim();
}

function activeRow(r){
  const v=String(r?.Aktif??'').trim().toLowerCase();
  return v!=='false'&&v!=='0';
}

function brandEq(a,b){
  a=normText(a);
  b=normText(b);

  return !!a&&!!b&&(
    a===b||
    (
      Math.min(a.length,b.length)>=5&&
      (
        a.includes(b)||
        b.includes(a)
      )
    )
  );
}

function productKey(u){
  return normCode(u?.sku)||
    `${String(u?.urun_linki||'').split('#')[0]}|${normText(u?.varyant_adi)}`;
}

function dedupe(arr=[]){
  const seen=new Set();

  return arr.filter(x=>{
    const k=productKey(x);

    if(!k||seen.has(k))return false;

    seen.add(k);
    return true;
  });
}

function esc(s){
  return String(s??'').replace(
    /[&<>'"]/g,
    c=>({
      '&':'&amp;',
      '<':'&lt;',
      '>':'&gt;',
      "'":'&#39;',
      '"':'&quot;'
    }[c])
  );
}

function money(v){
  if(v==null||v===''||v==='-')return null;

  let s=String(v).replace(/[^0-9,.-]/g,'');

  if(s.includes(',')&&s.includes('.'))
    s=s.replace(/\./g,'').replace(',','.');
  else if(s.includes(','))
    s=s.replace(',','.');

  const n=Number(s);

  return Number.isFinite(n)?n:null;
}

function fmtPrice(v){
  const n=money(v);

  return n==null
    ?'-'
    :n.toLocaleString('tr-TR',{
      minimumFractionDigits:2,
      maximumFractionDigits:2
    });
}

function apiURL(base,params){
  const u=new URL(base);

  Object.entries(params||{}).forEach(([k,v])=>{
    if(v!==undefined&&v!==null)
      u.searchParams.set(k,v);
  });

  return u;
}

async function getJSON(url,opt){
  const r=await fetch(url,opt);

  if(!r.ok){
    const e=new Error(`HTTP ${r.status}`);
    e.status=r.status;
    throw e;
  }

  return r.json();
}

async function postData(url,data){
  const r=await fetch(url,{
    method:'POST',
    headers:{
      'content-type':'application/json'
    },
    body:JSON.stringify(data)
  });

  if(!r.ok)
    throw new Error(`HTTP ${r.status}`);

  try{
    return await r.json();
  }catch{
    return {ok:true};
  }
}

async function sourceGet(sid,params){
  return getJSON(
    apiURL(
      supplierConfigs.get(sid).worker,
      params
    )
  );
}

async function sourceKvGet(sid,slug){
  try{
    return await getJSON(
      apiURL(
        supplierConfigs.get(sid).worker,
        {get:slug}
      )
    );
  }catch(e){
    if(e.status===404)return null;
    throw e;
  }
}

async function sourceKvSet(sid,slug,data){
  return postData(
    apiURL(
      supplierConfigs.get(sid).worker,
      {set:slug}
    ),
    data
  );
}

async function storageGet(key){
  if(!storageWorker)return null;

  try{
    return await getJSON(
      apiURL(
        storageWorker,
        {get:key}
      )
    );
  }catch(e){
    if(e.status===404)return null;
    throw e;
  }
}

async function storageSet(key,data){
  if(!storageWorker)return;

  return postData(
    apiURL(
      storageWorker,
      {set:key}
    ),
    data
  );
}

async function loadRegistry(){
  registry=await getJSON(
    REGISTRY_URL,
    {cache:'no-store'}
  );

  storageWorker=registry.storageWorker||'';

  for(const s of registry.suppliers||[]){
    try{
      const c=await getJSON(
        s.config,
        {cache:'no-store'}
      );

      supplierConfigs.set(
        s.id,
        {
          ...c,
          ready:s.ready!==false&&c.ready!==false,
          _configPath:s.config
        }
      );
    }catch(e){
      supplierConfigs.set(
        s.id,
        {
          id:s.id,
          name:s.id,
          ready:false,
          error:e.message
        }
      );
    }
  }

  selectedSuppliers=new Set(
    (registry.defaultSelected||[])
      .filter(id=>supplierConfigs.get(id)?.ready)
  );
}

async function loadBrands(sid){
  if(supplierBrands.has(sid))
    return supplierBrands.get(sid);

  const c=supplierConfigs.get(sid);

  if(!c?.ready)return[];

  const res=await sourceGet(
    sid,
    {brands:1}
  );

  const arr=(res.brands||[]).map(b=>
    typeof b==='string'
      ?{
        name:b,
        slug:normText(b)
      }
      :b
  );

  supplierBrands.set(sid,arr);

  return arr;
}

function supplierColor(c){
  return c?.color||'#777';
}

function renderSuppliers(){
  supplierList.innerHTML='';

  for(const s of registry.suppliers||[]){
    const c=supplierConfigs.get(s.id)||{};
    const b=document.createElement('button');

    b.className=
      'supplier-btn'+
      (
        selectedSuppliers.has(s.id)
          ?' active'
          :''
      );

    b.textContent=c.name||s.id;

    b.style.setProperty(
      '--supplier-color',
      supplierColor(c)
    );

    b.disabled=!c.ready;

    b.title=c.ready
      ?(c.name||s.id)
      :`${c.name||s.id} henüz hazır değil`;

    b.onclick=async()=>{
      if(!c.ready)return;

      if(selectedSuppliers.has(s.id))
        selectedSuppliers.delete(s.id);
      else
        selectedSuppliers.add(s.id);

      if(!selectedSuppliers.has(s.id)){
        for(const k of [...selectedBrands]){
          if(k.startsWith(s.id+':'))
            selectedBrands.delete(k);
        }

        if(activeSupplier===s.id)
          clearActive();
      }else{
        setStatus(`${c.name||s.id} markaları yükleniyor...`);

        try{
          await loadBrands(s.id);
        }catch(e){
          setStatus(`marka listesi hatası: ${e.message}`);
        }
      }

      renderSuppliers();
      renderBrands();
      setStatus('');
    };

    supplierList.appendChild(b);
  }
}

async function ensureSelectedBrandsLoaded(){
  await Promise.all(
    [...selectedSuppliers].map(
      id=>
        loadBrands(id).catch(e=>{
          setStatus(
            `${supplierConfigs.get(id)?.name||id}: ${e.message}`
          );

          return[];
        })
    )
  );
}

function renderBrands(){
  brandList.innerHTML='';

  for(const s of registry.suppliers||[]){
    if(!selectedSuppliers.has(s.id))
      continue;

    const c=supplierConfigs.get(s.id);
    const color=supplierColor(c);

    for(const b of supplierBrands.get(s.id)||[]){
      const key=`${s.id}:${b.slug}`;
      const btn=document.createElement('button');

      btn.className='brand-btn';

      if(
        activeSupplier===s.id&&
        activeBrand?.slug===b.slug
      ){
        btn.classList.add('active');
      }

      if(selectedBrands.has(key))
        btn.classList.add('multi-selected');

      btn.dataset.key=key;

      btn.style.setProperty(
        '--brand-color',
        color
      );

      btn.title=`${c.name} · ${b.name}`;

      btn.innerHTML=
        `<span>${esc(b.name)}</span>`+
        (
          b.count!=null
            ?` <small>${esc(b.count)}</small>`
            :''
        );

      btn.onclick=()=>{
        if(multiMode){
          if(selectedBrands.has(key))
            selectedBrands.delete(key);
          else
            selectedBrands.add(key);

          btn.classList.toggle(
            'multi-selected',
            selectedBrands.has(key)
          );

          setStatus(
            `${selectedBrands.size} marka seçildi`
          );
        }else{
          openBrand(
            s.id,
            b,
            btn
          );
        }
      };

      brandList.appendChild(btn);
    }
  }

  updateAllButton();
}

function clearActive(){
  activeSupplier=null;
  activeBrand=null;

  toolbar.classList.add('hidden');
  tableWrap.classList.add('hidden');

  $('col-toggles').classList.add('hidden');
  $('table-head').innerHTML='';

  tbody.innerHTML='';

  $('unmatched').classList.add('hidden');
  notice.classList.add('hidden');
}

function keyOf(sid,slug){
  return `${sid}:${slug}`;
}

async function openBrand(sid,b,btn){
  document
    .querySelectorAll('.brand-btn')
    .forEach(x=>x.classList.remove('active'));

  btn?.classList.add('active');

  activeSupplier=sid;
  activeBrand=b;

  toolbar.classList.remove('hidden');
  tableWrap.classList.remove('hidden');
  notice.classList.add('hidden');

  setStatus('yükleniyor...');

  const c=supplierConfigs.get(sid);

  $('brand-title').textContent=
    `${c.name} · ${b.name}`;

  let data=await sourceKvGet(
    sid,
    b.slug
  );

  if(data?.urunler){
    data={
      ...data,
      urunler:dedupe(data.urunler)
    };

    brandData.set(
      keyOf(sid,b.slug),
      data
    );

    renderCurrent();

    setStatus(
      data.guncelleme
        ?`Son Güncelleme: ${fmtFull(data.guncelleme)}`
        :''
    );
  }else{
    brandData.set(
      keyOf(sid,b.slug),
      null
    );

    renderColumns(c);

    tbody.innerHTML='';
    $('unmatched').classList.add('hidden');

    setStatus(
      `KV'de yok — Güncelle ile ilk çekimi yapın`
    );
  }
}

async function collectBrandRows(sid,b,c){
  const out=[];
  const seen=new Set();

  for(let page=1;page<=100;page++){
    setStatus(`sayfa ${page} taranıyor...`);

    let res;

    try{
      res=await sourceGet(
        sid,
        {
          u:b.slug,
          page,
          stop:9999,
          delay:c.delayMs||0,
          fields:(c.fields||[]).join(',')
        }
      );
    }catch(e){
      if(page===1)throw e;
      break;
    }

    const rows=(res.urunler||[])
      .filter(x=>x&&!x.hata);

    if(!rows.length)
      break;

    let added=0;

    for(const u of rows){
      const k=productKey(u);

      if(!seen.has(k)){
        seen.add(k);
        out.push(u);
        added++;
      }
    }

    if(!added)
      break;

    if(
      rows.length===1&&
      page>1&&
      out.length===1
    ){
      break;
    }

    await sleep(
      rand(
        150,
        c.jitterMs||0
      )
    );
  }

  return dedupe(out);
}

async function initBrand(sid,b){
  const c=supplierConfigs.get(sid);

  $('multi-progress').classList.remove('hidden');

  bar('brand-bar',5);

  const urunler=await collectBrandRows(
    sid,
    b,
    c
  );

  bar('brand-bar',90);

  const data={
    brand:b.slug,
    guncelleme:new Date().toISOString(),
    urunler
  };

  await sourceKvSet(
    sid,
    b.slug,
    data
  );

  brandData.set(
    keyOf(sid,b.slug),
    data
  );

  bar('brand-bar',100);

  renderCurrent();

  setStatus(
    `tamamlandı · ${urunler.length} ürün`
  );

  if(!multiRunning){
    setTimeout(
      ()=>$('multi-progress').classList.add('hidden'),
      500
    );
  }

  return data;
}

function findReturnedMatch(old,rows){
  const os=normCode(old.sku);

  return (
    rows.find(
      r=>
        os&&
        normCode(r.sku)===os
    )||
    rows.find(
      r=>
        old.varyant_adi&&
        normText(r.varyant_adi)===
        normText(old.varyant_adi)
    )||
    rows[0]||
    null
  );
}

async function refreshBrand(sid,b,data){
  const c=supplierConfigs.get(sid);

  data={
    ...data,
    urunler:dedupe(data.urunler||[])
  };

  const arr=data.urunler;
  const total=arr.length;

  $('multi-progress').classList.remove('hidden');

  bar('brand-bar',0);

  for(let i=0;i<total;i++){
    setStatus(
      `güncelleniyor ${i+1}/${total}`
    );

    try{
      const res=await sourceGet(
        sid,
        {
          u:arr[i].urun_linki,
          fields:(c.fields||[]).join(',')
        }
      );

      const rs=Array.isArray(res)
        ?res
        :[res];

      const m=findReturnedMatch(
        arr[i],
        rs.filter(x=>x&&!x.hata)
      );

      if(m)
        arr[i]={
          ...arr[i],
          ...m
        };
    }catch(e){
      console.warn(
        arr[i].urun_linki,
        e.message
      );
    }

    bar(
      'brand-bar',
      total
        ?((i+1)/total*85)
        :85
    );

    if(i<total-1){
      await sleep(
        rand(
          c.delayMs||0,
          c.jitterMs||0
        )
      );
    }
  }

  setStatus('yeni ürün kontrolü...');

  let live=[];

  try{
    live=await collectBrandRows(
      sid,
      b,
      {
        ...c,
        delayMs:Math.min(
          c.delayMs||0,
          500
        )
      }
    );
  }catch{}

  const oldKeys=new Set(
    arr.map(productKey)
  );

  const newRows=live.filter(
    u=>!oldKeys.has(productKey(u))
  );

  const json={
    ...data,
    urunler:dedupe(arr),
    guncelleme:new Date().toISOString()
  };

  if(newRows.length&&multiRunning){
    json.urunler=dedupe([
      ...(json.urunler||[]),
      ...newRows
    ]);

    await sourceKvSet(
      sid,
      b.slug,
      json
    );

    brandData.set(
      keyOf(sid,b.slug),
      json
    );

    setStatus(
      `güncellendi · ${newRows.length} yeni ürün eklendi`
    );
  }else if(newRows.length){
    showNotice(
      sid,
      b,
      newRows,
      json
    );
  }else{
    await sourceKvSet(
      sid,
      b.slug,
      json
    );

    brandData.set(
      keyOf(sid,b.slug),
      json
    );

    setStatus(
      'güncellendi — KV kaydedildi'
    );
  }

  bar('brand-bar',100);

  if(
    activeSupplier===sid&&
    activeBrand?.slug===b.slug
  ){
    brandData.set(
      keyOf(sid,b.slug),
      json
    );

    renderCurrent();
  }

  if(!multiRunning){
    setTimeout(
      ()=>$('multi-progress').classList.add('hidden'),
      500
    );
  }

  return json;
}

function showNotice(sid,b,newRows,json){
  notice.classList.remove('hidden');

  notice.innerHTML=
    `⚠ ${newRows.length} yeni ürün `+
    `<span class="new-badge">yükle</span>`;

  notice.onclick=async()=>{
    notice.classList.add('hidden');

    json.urunler=dedupe([
      ...(json.urunler||[]),
      ...newRows
    ]);

    json.guncelleme=
      new Date().toISOString();

    await sourceKvSet(
      sid,
      b.slug,
      json
    );

    brandData.set(
      keyOf(sid,b.slug),
      json
    );

    renderCurrent();

    setStatus(
      'yeni ürünler KV\'ye kaydedildi'
    );
  };
}

async function refreshSelectedBrands(){
  const keys=[...selectedBrands];

  if(!keys.length){
    setStatus('marka seçilmedi');
    return;
  }

  multiRunning=true;

  $('multi-progress').classList.remove('hidden');
  $('multi-log').innerHTML='';

  bar('general-bar',0);

  for(let i=0;i<keys.length;i++){
    const [
      sid,
      ...rest
    ]=keys[i].split(':');

    const slug=rest.join(':');

    const b=(supplierBrands.get(sid)||[])
      .find(x=>x.slug===slug);

    if(!b)continue;

    try{
      await openBrand(
        sid,
        b,
        document.querySelector(
          `.brand-btn[data-key="${CSS.escape(keys[i])}"]`
        )
      );

      let d=brandData.get(keys[i]);

      d=d
        ?await refreshBrand(
          sid,
          b,
          JSON.parse(
            JSON.stringify(d)
          )
        )
        :await initBrand(
          sid,
          b
        );

      brandData.set(
        keys[i],
        d
      );

      $('multi-log').insertAdjacentHTML(
        'beforeend',
        `<div>✓ ${esc(supplierConfigs.get(sid).name)} · ${esc(b.name)}</div>`
      );
    }catch(e){
      $('multi-log').insertAdjacentHTML(
        'beforeend',
        `<div>✕ ${esc(supplierConfigs.get(sid)?.name||sid)} · ${esc(b?.name||slug)} · ${esc(e.message)}</div>`
      );
    }

    bar(
      'general-bar',
      ((i+1)/keys.length)*100
    );
  }

  multiRunning=false;

  setStatus(
    'çoklu güncelleme tamamlandı'
  );
}

$('btn-refresh').onclick=async()=>{
  if(
    multiMode&&
    selectedBrands.size
  ){
    return refreshSelectedBrands();
  }

  if(
    !activeSupplier||
    !activeBrand
  ){
    setStatus('önce marka seçin');
    return;
  }

  const k=keyOf(
    activeSupplier,
    activeBrand.slug
  );

  const d=brandData.get(k);

  try{
    if(d){
      await refreshBrand(
        activeSupplier,
        activeBrand,
        JSON.parse(
          JSON.stringify(d)
        )
      );
    }else{
      await initBrand(
        activeSupplier,
        activeBrand
      );
    }
  }catch(e){
    setStatus(
      `hata: ${e.message}`
    );
  }
};

function updateAllButton(){
  $('mode-btn').textContent=
    multiMode
      ?'Tümü'
      :'Mod';

  $('btn-select').classList.toggle(
    'active',
    multiMode
  );
}

$('btn-select').onclick=()=>{
  multiMode=!multiMode;

  selectedBrands.clear();

  document
    .querySelectorAll('.brand-btn')
    .forEach(
      b=>b.classList.remove('multi-selected')
    );

  updateAllButton();

  setStatus(
    multiMode
      ?'çoklu marka seçimi açık'
      :''
  );
};

$('mode-btn').onclick=()=>{
  if(multiMode){
    document
      .querySelectorAll('.brand-btn')
      .forEach(b=>{
        const k=b.dataset.key;

        if(k){
          selectedBrands.add(k);
          b.classList.add('multi-selected');
        }
      });

    setStatus(
      `${selectedBrands.size} marka seçildi`
    );

    return;
  }

  document.body.classList.toggle(
    'dark-mode'
  );

  localStorage.setItem(
    'darkMode',
    document.body.classList.contains('dark-mode')
      ?'1'
      :'0'
  );
};

function parseCSV(text){
  const first=
    text.split(/\r?\n/,1)[0]||'';

  const semi=
    (first.match(/;/g)||[]).length;

  const comma=
    (first.match(/,/g)||[]).length;

  const delim=
    semi>=comma
      ?';'
      :',';

  const rows=[];
  const row=[];

  let cell='';
  let q=false;

  for(let i=0;i<text.length;i++){
    const ch=text[i];

    if(q){
      if(
        ch==='"'&&
        text[i+1]==='"'
      ){
        cell+='"';
        i++;
      }else if(ch==='"'){
        q=false;
      }else{
        cell+=ch;
      }
    }else if(ch==='"'){
      q=true;
    }else if(ch===delim){
      row.push(cell);
      cell='';
    }else if(ch==='\n'){
      row.push(
        cell.replace(/\r$/,'')
      );

      rows.push(
        row.splice(0)
      );

      cell='';
    }else{
      cell+=ch;
    }
  }

  if(cell.length||row.length){
    row.push(
      cell.replace(/\r$/,'')
    );

    rows.push(row);
  }

  const headers=
    (rows.shift()||[])
      .map(
        (h,i)=>
          (
            i===0
              ?h.replace(/^\uFEFF/,'')
              :h
          ).trim()
      );

  return{
    headers,
    delimiter:delim,
    rows:rows
      .filter(
        r=>r.some(
          x=>String(x).trim()!==''
        )
      )
      .map(
        a=>
          Object.fromEntries(
            headers.map(
              (h,i)=>[
                h,
                String(a[i]??'').trim()
              ]
            )
          )
      )
  };
}

function csvCell(v,d){
  v=String(v??'');

  return (
    v.includes(d)||
    /["\r\n]/.test(v)
  )
    ?`"${v.replace(/"/g,'""')}"`
    :v;
}

function serializeCSV(){
  if(!tsoftData)return'';

  const d=
    tsoftData.delimiter||';';

  const h=
    tsoftData.headers;

  return[
    h.map(
      x=>csvCell(x,d)
    ).join(d),

    ...tsoftData.rows.map(
      r=>
        h.map(
          x=>csvCell(
            r[x]??'',
            d
          )
        ).join(d)
    )
  ].join('\r\n');
}

function rebuildTsoft(){
  if(tsoftData)
    tsoftData.indexes=
      new Map();
}

async function loadTsoft(
  text,
  skipStore=false,
  date=''
){
  const p=parseCSV(text);

  tsoftData={
    ...p,
    text,
    date,
    indexes:new Map(),
    dirty:false
  };

  if(!skipStore){
    date=fmtFull(
      new Date().toISOString()
    );

    tsoftData.date=date;

    await storageSet(
      'tsoft:data',
      {
        text,
        date
      }
    );
  }

  $('tsoft-btn').textContent=
    'T-Soft ✓';

  if(activeSupplier)
    renderCurrent();
}

function tsoftIndex(field,mode){
  const key=
    `${field}|${mode}`;

  if(
    tsoftData.indexes.has(key)
  ){
    return tsoftData.indexes.get(key);
  }

  const m=new Map();

  for(const r of tsoftData.rows){
    const v=normalize(
      mode,
      r[field]
    );

    if(!v)continue;

    if(!m.has(v))
      m.set(v,[]);

    m.get(v).push(r);
  }

  tsoftData.indexes.set(
    key,
    m
  );

  return m;
}

function sourceUsage(products,cfg){
  const maps=[];

  for(
    const rule of
    cfg.match?.rules||[]
  ){
    const m=new Map();

    if(rule.unique){
      for(const u of products){
        const v=normalize(
          rule.normalize,
          u[rule.source]
        );

        if(v){
          m.set(
            v,
            (m.get(v)||0)+1
          );
        }
      }
    }

    maps.push(m);
  }

  return maps;
}

function pickCandidate(
  arr,
  brandName
){
  if(!arr?.length)
    return null;

  return(
    arr.find(
      r=>
        activeRow(r)&&
        brandEq(
          r.Marka,
          brandName
        )
    )||
    arr.find(
      r=>
        brandEq(
          r.Marka,
          brandName
        )
    )||
    arr.find(activeRow)||
    arr[0]
  );
}

function findTsoft(
  u,
  cfg,
  brandName,
  usage
){
  if(!tsoftData)
    return null;

  const rules=
    cfg.match?.rules||[];

  for(let i=0;i<rules.length;i++){
    const rule=rules[i];

    const v=normalize(
      rule.normalize,
      u[rule.source]
    );

    if(!v)continue;

    if(
      rule.unique&&
      (usage[i]?.get(v)||0)>1
    ){
      continue;
    }

    let candidates=[];

    for(
      const target of
      rule.targets||[]
    ){
      candidates.push(
        ...(
          tsoftIndex(
            target,
            rule.normalize
          ).get(v)||[]
        )
      );
    }

    const hit=pickCandidate(
      [...new Set(candidates)],
      brandName
    );

    if(hit)
      return hit;
  }

  return null;
}

function aideStok(ts,cfg){
  if(
    !aideData||
    !ts||
    cfg.aide?.enabled===false
  ){
    return null;
  }

  for(
    const f of
    cfg.aide?.tsoftFields||[]
  ){
    const k=
      String(ts[f]||'')
        .trim()
        .toUpperCase();

    if(!k)continue;

    const v=
      aideData.get(k)??
      aideData.get(
        k.replace(
          /^0+(?=\d)/,
          ''
        )
      );

    if(v!=null)
      return v;
  }

  return null;
}

function parseAide(
  text,
  skipStore=false,
  date=''
){
  aideData=new Map();

  for(
    const line of
    text.split(/\r?\n/)
  ){
    const p=
      line.split('\t')
        .map(s=>s.trim());

    if(p.length<6)
      continue;

    const ambar=
      (p[5]||'')
        .toLowerCase()
        .trim();

    if(
      ![
        'sesci magaza',
        'sescibaba'
      ].includes(ambar)
    ){
      continue;
    }

    const k=
      (p[2]||'')
        .trim()
        .toUpperCase();

    const n=
      parseFloat(
        (p[4]||'0')
          .replace(',','.')
      )||0;

    if(!k)continue;

    aideData.set(
      k,
      (aideData.get(k)||0)+n
    );

    const a=
      k.replace(
        /^0+(?=\d)/,
        ''
      );

    if(a!==k){
      aideData.set(
        a,
        (aideData.get(a)||0)+n
      );
    }
  }

  if(!skipStore){
    date=fmtFull(
      new Date().toISOString()
    );

    storageSet(
      'aide:data',
      {
        text,
        date
      }
    );
  }

  $('aide-btn').textContent=
    'Aide ✓';

  if(activeSupplier)
    renderCurrent();
}

function currentVisibility(cfg){
  let saved={};

  try{
    saved=JSON.parse(
      localStorage.getItem(
        `cols:${cfg.id}`
      )||'{}'
    );
  }catch{}

  return Object.fromEntries(
    (cfg.columns||[])
      .map(
        c=>[
          c.id,
          saved[c.id]??
          c.visible!==false
        ]
      )
  );
}

function saveVisibility(cfg,vis){
  localStorage.setItem(
    `cols:${cfg.id}`,
    JSON.stringify(vis)
  );
}

function renderColumns(cfg){
  const vis=currentVisibility(cfg);
  const head=$('table-head');
  const tog=$('col-toggles');

  head.innerHTML=
    '<tr>'+
    cfg.columns.map(
      c=>
        `<th data-col="${esc(c.id)}" class="${vis[c.id]?'':'col-hidden'}">${esc(c.label)}</th>`
    ).join('')+
    '</tr>';

  tog.innerHTML='';

  const garage=
    document.createElement('label');

  garage.innerHTML=
    '<input type="checkbox" id="chk-garage"> Garaj';

  tog.appendChild(garage);

  for(const c of cfg.columns){
    const l=
      document.createElement('label');

    const ch=
      document.createElement('input');

    ch.type='checkbox';
    ch.checked=!!vis[c.id];
    ch.dataset.col=c.id;

    ch.onchange=()=>{
      vis[c.id]=ch.checked;

      saveVisibility(
        cfg,
        vis
      );

      document
        .querySelectorAll(
          `[data-col="${CSS.escape(c.id)}"]`
        )
        .forEach(
          x=>
            x.classList.toggle(
              'col-hidden',
              !ch.checked
            )
        );
    };

    l.append(
      ch,
      document.createTextNode(
        ' '+c.label
      )
    );

    tog.appendChild(l);
  }

  garage
    .querySelector('input')
    .onchange=applyRowFilters;

  tog.classList.remove('hidden');
}

function sourcePriceLink(u,v){
  return u.urun_linki
    ?`<a href="${esc(u.urun_linki)}" target="_blank">${esc(v||'-')}</a>`
    :esc(v||'-');
}

function tsoftUrl(ts){
  const s=
    String(
      ts?.['SEO Link']||''
    ).trim();

  return s
    ?`https://www.sescibaba.com/${s}`
    :'';
}

function cellHTML(
  col,
  u,
  ts,
  aide,
  i,
  cfg
){
  let cls='';
  let html='-';

  switch(col.type){
    case'index':
      html=String(i+1);
      break;

    case'image':
      html=
        u[col.field]
          ?`<img class="thumb" src="${esc(u[col.field])}" loading="lazy">`
          :'<div class="no-img"></div>';
      break;

    case'sku':
      html=
        `<span class="copyable" data-copy="${esc(u[col.field]||'')}">${esc(u[col.field]||'-')}</span>`;
      break;

    case'product':
      html=
        `<span class="copyable product-name" data-copy="${esc(
          (u[col.field]||'')+
          (
            u.varyant_adi
              ?' · '+u.varyant_adi
              :''
          )
        )}">${esc(u[col.field]||'-')}${
          u.varyant_adi
            ?` <small>· ${esc(u.varyant_adi)}</small>`
            :''
        }</span>`;

      cls='product-cell';
      break;

    case'text':
      html=esc(
        u[col.field]??'-'
      );
      break;

    case'stock':
      html=esc(
        u[col.field]??'-'
      );

      cls='source-stock';
      break;

    case'aideStock':
      html=
        aide==null
          ?'-'
          :esc(aide);
      break;

    case'tsoft':
      html=
        ts
          ?esc(ts[col.field]??'-')
          :'-';

      if(col.field==='Ürün Adı')
        cls='product-cell';

      break;

    case'price':
      html=sourcePriceLink(
        u,
        u[col.field]
      );

      cls='num';
      break;

    case'tsoftPrice':{
      const v=
        ts
          ?fmtPrice(ts[col.field])
          :'-';

      const url=
        tsoftUrl(ts);

      html=
        url
          ?`<a href="${esc(url)}" target="_blank">${esc(v)}</a>`
          :esc(v);

      cls='num';

      break;
    }

    case'difference':{
      const pc=
        (cfg.columns||[])
          .find(
            x=>x.type==='price'
          );

      const tc=
        (cfg.columns||[])
          .find(
            x=>x.type==='tsoftPrice'
          );

      const a=
        money(
          pc
            ?u[pc.field]
            :null
        );

      const b=
        money(
          tc&&ts
            ?ts[tc.field]
            :null
        );

      if(a&&b){
        const p=
          (b-a)/a*100;

        const abs=
          Math.abs(p)
            .toFixed(1)
            .replace('.',',');

        html=
          `%${abs} ${p>0?'↑':'↓'}`;

        cls=
          p>0
            ?'diff-up'
            :'diff-down';
      }

      break;
    }
  }

  return(
    `<td data-col="${esc(col.id)}" class="${cls}">${html}</td>`
  );
}

function computeView(
  products,
  cfg,
  brandName
){
  const usage=
    sourceUsage(
      products,
      cfg
    );

  const matches=[];
  const matchedRows=new Set();
  const sourceOnly=[];

  products.forEach(u=>{
    const ts=
      findTsoft(
        u,
        cfg,
        brandName,
        usage
      );

    matches.push(ts);

    if(ts)
      matchedRows.add(ts);
    else
      sourceOnly.push(u);
  });

  const tsoftOnly=
    tsoftData
      ?tsoftData.rows.filter(
        r=>
          activeRow(r)&&
          brandEq(
            r.Marka,
            brandName
          )&&
          !matchedRows.has(r)
      )
      :[];

  return{
    matches,
    sourceOnly,
    tsoftOnly
  };
}

function renderCurrent(){
  if(
    !activeSupplier||
    !activeBrand
  ){
    return;
  }

  const cfg=
    supplierConfigs.get(
      activeSupplier
    );

  const data=
    brandData.get(
      keyOf(
        activeSupplier,
        activeBrand.slug
      )
    );

  renderColumns(cfg);

  const products=
    data?.urunler||[];

  const brandName=
    products.find(
      x=>x.marka_adi
    )?.marka_adi||
    activeBrand.name;

  const view=
    computeView(
      products,
      cfg,
      brandName
    );

  tbody.innerHTML=
    products.map(
      (u,i)=>{
        const ts=
          view.matches[i];

        const aide=
          aideStok(
            ts,
            cfg
          );

        const out=
          (Number(u.stok)||0)<=0
            ?' out'
            :'';

        const matched=
          ts
            ?' match-ok'
            :' match-none';

        return(
          `<tr data-key="${esc(productKey(u))}" class="${matched}${out}" data-garage="${
            /hasar|garaj/i.test(
              (u.urun_adi||'')+
              ' '+
              (u.varyant_adi||'')
            )
              ?'1'
              :'0'
          }">${
            cfg.columns.map(
              c=>
                cellHTML(
                  c,
                  u,
                  ts,
                  aide,
                  i,
                  cfg
                )
            ).join('')
          }</tr>`
        );
      }
    ).join('');

  applySavedVisibility(cfg);
  applyRowFilters();

  renderUnmatched(
    view.sourceOnly,
    view.tsoftOnly,
    cfg,
    brandName
  );

  $('brand-title').textContent=
    `${cfg.name} · ${activeBrand.name} · ${products.length} ürün${
      data?.guncelleme
        ?' · '+fmtFull(data.guncelleme)
        :''
    }`;
}

function applySavedVisibility(cfg){
  const vis=
    currentVisibility(cfg);

  for(const c of cfg.columns){
    document
      .querySelectorAll(
        `[data-col="${CSS.escape(c.id)}"]`
      )
      .forEach(
        x=>
          x.classList.toggle(
            'col-hidden',
            !vis[c.id]
          )
      );
  }
}

function applyRowFilters(){
  const show=
    $('chk-garage')?.checked||
    false;

  tbody
    .querySelectorAll('tr')
    .forEach(
      tr=>
        tr.classList.toggle(
          'row-hidden',
          tr.dataset.garage==='1'&&
          !show
        )
    );
}

function manualRule(cfg){
  return(
    cfg.match?.rules?.[0]||
    null
  );
}

function manualTarget(cfg){
  return(
    manualRule(cfg)?.targets?.[0]||
    'Web Servis Kodu'
  );
}

function manualValue(u,cfg){
  const r=manualRule(cfg);

  return r
    ?normalize(
      r.normalize,
      u[r.source]
    )
    :String(u.sku||'').trim();
}

async function commitTsoft(){
  if(!tsoftData)return;

  const text=
    serializeCSV();

  const date=
    fmtFull(
      new Date().toISOString()
    );

  tsoftData.text=text;
  tsoftData.date=date;
  tsoftData.dirty=true;

  rebuildTsoft();

  await storageSet(
    'tsoft:data',
    {
      text,
      date
    }
  );
}

function renderUnmatched(
  sourceOnly,
  tsoftOnly,
  cfg,
  brandName
){
  const box=$('unmatched');

  if(
    !tsoftData||
    (
      !sourceOnly.length&&
      !tsoftOnly.length
    )
  ){
    box.classList.add('hidden');
    box.innerHTML='';
    return;
  }

  const target=
    manualTarget(cfg);

  const opts=
    tsoftOnly.map(
      (r,i)=>
        `<option value="${i}">${esc(r[target]||'-')} · ${esc(r['Ürün Adı']||'-')}</option>`
    ).join('');

  box.innerHTML=
    `<div class="unmatched-head">
      <strong>Eşleşmeyenler</strong>
      <button id="download-tsoft">T-Soft CSV İndir</button>
    </div>

    <div class="unmatched-grid">

      <div class="unmatched-col">

        <h3>${esc(cfg.name)}'da var · T-Soft'ta yok</h3>

        <table>

          <thead>
            <tr>
              <th>SKU</th>
              <th>Ürün</th>
              <th>T-Soft Kaydı</th>
              <th></th>
            </tr>
          </thead>

          <tbody>

            ${sourceOnly.map(
              (u,i)=>
                `<tr>
                  <td>${esc(u.sku||'-')}</td>

                  <td class="product-cell">
                    ${esc(u.urun_adi||'-')}
                    ${
                      u.varyant_adi
                        ?` · ${esc(u.varyant_adi)}`
                        :''
                    }
                  </td>

                  <td>
                    <select data-source="${i}">
                      <option value="">Seç...</option>
                      ${opts}
                    </select>
                  </td>

                  <td>
                    <button class="bind-btn" data-source="${i}">
                      Bağla
                    </button>
                  </td>
                </tr>`
            ).join('')}

          </tbody>

        </table>

      </div>

      <div class="unmatched-col">

        <h3>T-Soft'ta var · ${esc(cfg.name)}'da yok</h3>

        <table>

          <thead>
            <tr>
              <th>${esc(target)}</th>
              <th>Ürün</th>
              <th>Stok</th>
              <th></th>
            </tr>
          </thead>

          <tbody>

            ${tsoftOnly.map(
              (r,i)=>
                `<tr>

                  <td>
                    <input
                      class="ws-edit"
                      data-ts="${i}"
                      value="${esc(r[target]||'')}"
                    >
                  </td>

                  <td class="product-cell">
                    ${esc(r['Ürün Adı']||'-')}
                  </td>

                  <td>
                    ${esc(r.Stok||'-')}
                  </td>

                  <td>
                    <button class="save-ws" data-ts="${i}">
                      Kaydet
                    </button>
                  </td>

                </tr>`
            ).join('')}

          </tbody>

        </table>

      </div>

    </div>`;

  box.classList.remove('hidden');

  unmatchedState={
    sourceOnly,
    tsoftOnly,
    cfg,
    brandName,
    target
  };

  $('download-tsoft').onclick=
    downloadTsoftCSV;

  box
    .querySelectorAll('.bind-btn')
    .forEach(
      btn=>
        btn.onclick=async()=>{
          const i=
            +btn.dataset.source;

          const sel=
            box.querySelector(
              `select[data-source="${i}"]`
            );

          const j=
            Number(sel.value);

          if(
            sel.value===''||
            !tsoftOnly[j]
          ){
            return;
          }

          const val=
            manualValue(
              sourceOnly[i],
              cfg
            );

          if(!val){
            alert('Kaynak kod bulunamadı');
            return;
          }

          tsoftOnly[j][target]=val;

          await commitTsoft();

          renderCurrent();

          setStatus(
            `${target} güncellendi`
          );
        }
    );

  box
    .querySelectorAll('.save-ws')
    .forEach(
      btn=>
        btn.onclick=async()=>{
          const i=
            +btn.dataset.ts;

          const input=
            box.querySelector(
              `.ws-edit[data-ts="${i}"]`
            );

          tsoftOnly[i][target]=
            input.value.trim();

          await commitTsoft();

          renderCurrent();

          setStatus(
            `${target} güncellendi`
          );
        }
    );
}

function downloadTsoftCSV(){
  if(!tsoftData)return;

  const blob=
    new Blob(
      [
        '\uFEFF'+
        serializeCSV()
      ],
      {
        type:'text/csv;charset=utf-8;'
      }
    );

  const a=
    document.createElement('a');

  a.href=
    URL.createObjectURL(blob);

  a.download=
    'products-guncel.csv';

  a.click();

  setTimeout(
    ()=>URL.revokeObjectURL(a.href),
    0
  );
}

function openDataModal(
  mode,
  existingDate
){
  const modal=
    $('data-modal');

  modal.dataset.mode=mode;

  $('data-modal-title').textContent=
    mode==='tsoft'
      ?'T-Soft Verisi'
      :'Aide Verisi';

  const ex=
    $('data-modal-existing');

  if(existingDate){
    ex.textContent=
      `${existingDate} Tarihli veriyi yükle`;

    ex.style.display='';
  }else{
    ex.style.display='none';
  }

  $('data-modal-new').textContent=
    mode==='tsoft'
      ?'Yeni CSV yükle'
      :'Yeni yapıştır';

  modal.classList.remove('hidden');
}

$('data-modal-cancel').onclick=
  ()=>
    $('data-modal')
      .classList.add('hidden');

$('data-modal-existing').onclick=
  async()=>{
    const mode=
      $('data-modal').dataset.mode;

    $('data-modal')
      .classList.add('hidden');

    try{
      const d=
        await storageGet(
          mode==='tsoft'
            ?'tsoft:data'
            :'aide:data'
        );

      if(
        mode==='tsoft'&&
        d?.text
      ){
        await loadTsoft(
          d.text,
          true,
          d.date||''
        );
      }

      if(
        mode==='aide'&&
        d?.text
      ){
        parseAide(
          d.text,
          true,
          d.date||''
        );
      }
    }catch(e){
      alert(
        'KV hatası: '+
        e.message
      );
    }
  };

$('data-modal-new').onclick=
  ()=>{
    const mode=
      $('data-modal').dataset.mode;

    $('data-modal')
      .classList.add('hidden');

    if(mode==='tsoft')
      $('tsoft-file').click();
    else
      $('aide-modal')
        .classList.remove('hidden');
  };

$('tsoft-btn').onclick=
  async()=>{
    const d=
      await storageGet(
        'tsoft:data'
      ).catch(()=>null);

    openDataModal(
      'tsoft',
      d?.date||null
    );
  };

$('aide-btn').onclick=
  async()=>{
    const d=
      await storageGet(
        'aide:data'
      ).catch(()=>null);

    openDataModal(
      'aide',
      d?.date||null
    );
  };

$('tsoft-file').onchange=
  async e=>{
    const f=
      e.target.files[0];

    if(f)
      await loadTsoft(
        await f.text()
      );

    e.target.value='';
  };

$('aide-close').onclick=
  ()=>
    $('aide-modal')
      .classList.add('hidden');

$('aide-load').onclick=
  ()=>{
    const t=
      $('aide-paste').value;

    if(t.trim()){
      parseAide(t);

      $('aide-modal')
        .classList.add('hidden');
    }
  };

function downloadTableCSV(){
  if(!activeSupplier)
    return;

  const cfg=
    supplierConfigs.get(
      activeSupplier
    );

  const vis=
    currentVisibility(cfg);

  const cols=
    cfg.columns.filter(
      c=>vis[c.id]
    );

  const lines=[
    cols.map(
      c=>
        `"${String(c.label).replace(/"/g,'""')}"`
    ).join(';')
  ];

  for(
    const tr of
    tbody.querySelectorAll(
      'tr:not(.row-hidden)'
    )
  ){
    const vals=
      cols.map(c=>{
        const td=
          tr.querySelector(
            `[data-col="${CSS.escape(c.id)}"]`
          );

        return(
          `"${String(td?.textContent||'')
            .replace(/\s+/g,' ')
            .trim()
            .replace(/"/g,'""')}"`
        );
      });

    lines.push(
      vals.join(';')
    );
  }

  const blob=
    new Blob(
      [
        '\uFEFF'+
        lines.join('\r\n')
      ],
      {
        type:'text/csv;charset=utf-8;'
      }
    );

  const a=
    document.createElement('a');

  a.href=
    URL.createObjectURL(blob);

  a.download=
    `${activeSupplier}-${activeBrand?.slug||'tablo'}.csv`;

  a.click();

  setTimeout(
    ()=>URL.revokeObjectURL(a.href),
    0
  );
}

$('save-table-btn').onclick=
  downloadTableCSV;

document.addEventListener(
  'click',
  e=>{
    const cp=
      e.target.closest('.copyable');

    if(cp?.dataset.copy){
      navigator.clipboard.writeText(
        cp.dataset.copy
      );

      return;
    }

    const tr=
      e.target.closest(
        '#main-table tbody tr'
      );

    if(
      !tr||
      e.target.closest(
        'a,button,input,select,textarea,.copyable'
      )
    ){
      return;
    }

    tr.classList.toggle('sel');
  }
);

function updateSticky(){
  const h=
    $('sticky-header')?.offsetHeight||
    0;

  document.documentElement.style.setProperty(
    '--sticky-h',
    h+'px'
  );
}

if(window.ResizeObserver){
  new ResizeObserver(
    updateSticky
  ).observe(
    $('sticky-header')
  );
}

window.addEventListener(
  'resize',
  updateSticky
);

async function loadGlobalData(){
  try{
    const ts=
      await storageGet(
        'tsoft:data'
      );

    if(ts?.text){
      await loadTsoft(
        ts.text,
        true,
        ts.date||''
      );
    }
  }catch{}

  try{
    const ai=
      await storageGet(
        'aide:data'
      );

    if(ai?.text){
      parseAide(
        ai.text,
        true,
        ai.date||''
      );
    }
  }catch{}
}

async function init(){
  if(
    localStorage.getItem(
      'darkMode'
    )==='1'
  ){
    document.body.classList.add(
      'dark-mode'
    );
  }

  try{
    await loadRegistry();

    renderSuppliers();

    await ensureSelectedBrandsLoaded();

    renderBrands();

    await loadGlobalData();

    updateSticky();

    setStatus('');
  }catch(e){
    setStatus(
      `başlatma hatası: ${e.message}`
    );
  }
}

init();





