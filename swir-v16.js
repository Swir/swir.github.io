/* SWIR OS 1.7 — App SDK & Package Core integration */
(() => {
  'use strict';
  const $=(s,r=document)=>r.querySelector(s);
  const open=id=>window.SwirOS?.open?.(id);
  const toast=(t,m)=>window.SwirOS?.toast?.(t,m);
  const installed=()=>{try{const v=JSON.parse(localStorage.getItem('swir-installed-apps')||'[]');return new Set(Array.isArray(v)?v:[])}catch{return new Set()}};

  function patchRuntimeVersion(){
    const system=window.SwirPlatform?.system;if(!system||system.__swirV16Patched)return;
    const original=system.info?.bind(system);if(!original)return;
    system.info=()=>({...original(),version:'1.7.0',core:'NEON CORE',edition:'WEB',build:'2026.09',platformApi:2});
    Object.defineProperty(system,'__swirV16Patched',{value:true,enumerable:false});
  }

  function addQuickTile(){
    const grid=$('#quick-center .quick-grid');if(!grid||$('#quick-packages-open'))return;
    const b=document.createElement('button');b.id='quick-packages-open';b.className='quick-tile';b.type='button';
    b.innerHTML='<strong>PACKAGE MANAGER <span class="v13-quick-tag">1.7</span></strong><span>Install SWIR App Packages</span>';
    b.addEventListener('click',()=>open('store'));grid.appendChild(b);
  }

  function line(text,cls='term-muted'){const out=$('#terminal-output');if(!out)return;const d=document.createElement('div');d.className=cls;d.textContent=text;out.appendChild(d);out.scrollTop=out.scrollHeight}
  function wireTerminal(){
    document.addEventListener('keydown',e=>{
      const input=e.target;if(!(input instanceof HTMLInputElement)||input.id!=='terminal-input'||e.key!=='Enter')return;
      const raw=input.value.trim(),parts=raw.toLowerCase().split(/\s+/),cmd=parts[0];
      if(!['pkg','packages','sdk','appinfo','install','remove'].includes(cmd))return;
      e.preventDefault();e.stopImmediatePropagation();input.value='';line(`swir@neon-core:~$ ${raw}`,'term-ok');
      const catalog=window.SWIR_PACKAGE_CATALOG||[],on=installed();
      if(cmd==='sdk'){line('SWIR App SDK 1.1.0 // schema swir.app/1.0 // FILE ASSOCIATIONS 1.0 // WEB adapter','term-accent');return}
      if(cmd==='pkg'||cmd==='packages'){
        catalog.forEach(p=>line(`${on.has(p.id)?'[INSTALLED]':'[AVAILABLE]'} ${p.id.padEnd(8)} ${p.name} v${p.version}`,on.has(p.id)?'term-accent':'term-muted'));
        return;
      }
      const id=parts[1],pkg=catalog.find(p=>p.id===id||p.packageId===id);
      if(!pkg){line('Package not found. Use: pkg','term-error');return}
      if(cmd==='appinfo'){
        line(`${pkg.name} // ${pkg.packageId} // v${pkg.version}`,'term-accent');line(`ENTRY=${pkg.entry} CATEGORY=${pkg.category}`);line(`PERMISSIONS=${(pkg.permissions||[]).join(', ')||'none'}`);line(`ASSOCIATIONS=${(pkg.associations||[]).join(', ')||'none'}`);line(`APPDATA=${pkg.appData||'SWIR://APPDATA/'+pkg.id.toUpperCase()}`);return;
      }
      line(`${cmd.toUpperCase()} requires Store permission review. Opening SWIR Store...`,'term-accent');open('store');
    },true);
  }

  function updateLabels(){
    document.title='SWIR OS 1.7 — Neon Core';
    const replacements=[[/NEON CORE 1\.6/g,'NEON CORE 1.7'],[/NEON CORE \/\/ v1\.6/g,'NEON CORE // v1.7'],[/SWIR OS \/ NEON CORE 1\.6/g,'SWIR OS / NEON CORE 1.7'],[/SWIR OS v1\.6/g,'SWIR OS v1.7']];
    const nodes=[...document.querySelectorAll('.boot-subtitle,.topbar-brand span:last-child,.launcher-brand span,.widget-subtitle,.lock-session')];
    nodes.forEach(n=>{let h=n.innerHTML;replacements.forEach(([a,b])=>h=h.replace(a,b));n.innerHTML=h});
  }

  function modernizeBootLog(){
    const log=$('#boot-log');if(!log)return;
    const fix=node=>{if(!(node instanceof HTMLElement))return;node.textContent=node.textContent.replace('Mounting preserved apps','Loading package registry').replace('Initializing SWIR LAB','Starting App SDK services')};
    [...log.children].forEach(fix);new MutationObserver(records=>records.forEach(r=>r.addedNodes.forEach(fix))).observe(log,{childList:true});
  }

  function showPackageStatus(){
    const shell=$('#os-shell');if(!shell||$('#v16-package-pill'))return;
    const total=(window.SWIR_PACKAGE_CATALOG||[]).length,count=(window.SWIR_PACKAGE_CATALOG||[]).filter(p=>installed().has(p.id)).length;
    const el=document.createElement('aside');el.id='v16-package-pill';el.className='v16-package-pill';
    el.innerHTML=`<strong>APP SDK 1.1</strong><span>PACKAGES ${count}/${total} • FILE TYPES ENABLED</span>`;el.addEventListener('click',()=>open('store'));shell.appendChild(el);
  }

  function addSystemFileCards(frame){
    let doc;try{doc=frame.contentDocument}catch{return}if(!doc)return;
    const nav=doc.querySelector('#system-files-nav');if(!nav||nav.dataset.v16==='1')return;nav.dataset.v16='1';
    const append=()=>setTimeout(()=>{
      const title=doc.querySelector('#title'),grid=doc.querySelector('#grid');if(!grid||title?.textContent!=='System Files'||doc.querySelector('#v16-package-spec'))return;
      const make=(id,icon,name,desc,click)=>{const c=doc.createElement('article');c.id=id;c.className='item';c.innerHTML=`<div class="ico">${icon}</div><strong>${name}</strong><span>${desc}</span>`;c.addEventListener('click',click);grid.appendChild(c)};
      make('v16-package-spec','APP','SWIR App Package 1.0','Manifest, permissions, file associations and future .swirapp archive specification.',()=>window.open('https://raw.githubusercontent.com/Swir/swir.github.io/main/SWIR-APP-PACKAGE-1.0.md','_blank','noopener,noreferrer'));
      make('v16-package-store','S+','SWIR Store 2.1','Install, remove and inspect official SWIR application packages.',()=>open('store'));
      make('v16-default-apps','DF','Default Apps','Manage file associations and Open With defaults.',()=>open('defaults'));
    },40);
    nav.addEventListener('click',append);
  }

  function watchFileExplorer(){
    const layer=$('#window-layer');if(!layer)return;
    const attach=frame=>{if(!(frame instanceof HTMLIFrameElement)||frame.dataset.v16Files==='1')return;let path='';try{path=new URL(frame.src,location.href).pathname.toLowerCase()}catch{}if(!path.endsWith('/swir-files.html'))return;frame.dataset.v16Files='1';frame.addEventListener('load',()=>addSystemFileCards(frame));setTimeout(()=>addSystemFileCards(frame),80)};
    layer.querySelectorAll('iframe').forEach(attach);
    new MutationObserver(rs=>rs.forEach(r=>r.addedNodes.forEach(n=>{if(n instanceof HTMLIFrameElement)attach(n);if(n instanceof Element)n.querySelectorAll?.('iframe').forEach(attach)}))).observe(layer,{childList:true,subtree:true});
  }

  function init(){if(!window.SwirOS||!window.SwirAppSDK){setTimeout(init,60);return}patchRuntimeVersion();updateLabels();modernizeBootLog();addQuickTile();wireTerminal();showPackageStatus();watchFileExplorer();setTimeout(()=>toast('SWIR OS 1.7','App SDK 1.1 and file association manifests are online.'),1400)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
