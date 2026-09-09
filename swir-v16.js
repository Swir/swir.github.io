/* SWIR OS 1.6 — App SDK & Package Core integration */
(() => {
  'use strict';
  const $=(s,r=document)=>r.querySelector(s);
  const open=id=>window.SwirOS?.open?.(id);
  const toast=(t,m)=>window.SwirOS?.toast?.(t,m);
  const installed=()=>{try{const v=JSON.parse(localStorage.getItem('swir-installed-apps')||'[]');return new Set(Array.isArray(v)?v:[])}catch{return new Set()}};

  function addQuickTile(){
    const grid=$('#quick-center .quick-grid');if(!grid||$('#quick-packages-open'))return;
    const b=document.createElement('button');b.id='quick-packages-open';b.className='quick-tile';b.type='button';
    b.innerHTML='<strong>PACKAGE MANAGER <span class="v13-quick-tag">1.6</span></strong><span>Install SWIR App Packages</span>';
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
      if(cmd==='sdk'){line('SWIR App SDK 1.0.0 // schema swir.app/1.0 // WEB adapter','term-accent');return}
      if(cmd==='pkg'||cmd==='packages'){
        catalog.forEach(p=>line(`${on.has(p.id)?'[INSTALLED]':'[AVAILABLE]'} ${p.id.padEnd(8)} ${p.name} v${p.version}`,on.has(p.id)?'term-accent':'term-muted'));
        return;
      }
      const id=parts[1],pkg=catalog.find(p=>p.id===id||p.packageId===id);
      if(!pkg){line('Package not found. Use: pkg','term-error');return}
      if(cmd==='appinfo'){
        line(`${pkg.name} // ${pkg.packageId} // v${pkg.version}`,'term-accent');line(`ENTRY=${pkg.entry} CATEGORY=${pkg.category}`);line(`PERMISSIONS=${(pkg.permissions||[]).join(', ')||'none'}`);return;
      }
      line(`${cmd.toUpperCase()} requires Store permission review. Opening SWIR Store...`,'term-accent');open('store');
    },true);
  }

  function updateLabels(){
    document.title='SWIR OS 1.6 — Neon Core';
    const replacements=[[/NEON CORE 1\.5/g,'NEON CORE 1.6'],[/NEON CORE \/\/ v1\.5/g,'NEON CORE // v1.6'],[/SWIR OS \/ NEON CORE 1\.5/g,'SWIR OS / NEON CORE 1.6'],[/SWIR OS v1\.5/g,'SWIR OS v1.6']];
    const nodes=[...document.querySelectorAll('.boot-subtitle,.topbar-brand span:last-child,.launcher-brand span,.widget-subtitle,.lock-session')];
    nodes.forEach(n=>{let h=n.innerHTML;replacements.forEach(([a,b])=>h=h.replace(a,b));n.innerHTML=h});
  }

  function showPackageStatus(){
    const shell=$('#os-shell');if(!shell||$('#v16-package-pill'))return;
    const total=(window.SWIR_PACKAGE_CATALOG||[]).length,count=(window.SWIR_PACKAGE_CATALOG||[]).filter(p=>installed().has(p.id)).length;
    const el=document.createElement('aside');el.id='v16-package-pill';el.className='v16-package-pill';
    el.innerHTML=`<strong>APP SDK 1.0</strong><span>PACKAGES ${count}/${total} • SCHEMA swir.app/1.0</span>`;el.addEventListener('click',()=>open('store'));shell.appendChild(el);
  }

  function init(){if(!window.SwirOS||!window.SwirAppSDK){setTimeout(init,60);return}updateLabels();addQuickTile();wireTerminal();showPackageStatus();setTimeout(()=>toast('SWIR OS 1.6','App SDK 1.0 and SWIR App Package 1.0 are online.'),1400)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
