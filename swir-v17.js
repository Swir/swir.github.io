/* SWIR OS 1.7 — Files, Associations, Notifications, Secure Package Pipeline & Runtime integration */
(() => {
  'use strict';
  const $=(s,r=document)=>r.querySelector(s);
  const open=id=>window.SwirOS?.open?.(id);
  const toast=(t,m)=>window.SwirOS?.toast?.(t,m);
  let coreLoading=false;

  function loadRuntimeCore(){
    if((window.SwirRuntime&&window.SwirTrustedKeys&&window.SwirPackageIntegrity&&window.SwirInstallPipeline)||coreLoading)return;
    coreLoading=true;
    const load=(src)=>new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.async=false;s.onload=resolve;s.onerror=reject;document.head.appendChild(s)});
    (async()=>{
      try{
        if(!window.SwirRuntime)await load('./swir-runtime.js');
        if(!window.SwirTrustedKeys)await load('./swir-trusted-keys.js');
        if(!window.SwirPackageIntegrity)await load('./swir-package-integrity.js');
        if(!window.SwirInstallPipeline)await load('./swir-install-pipeline.js');
      }catch(error){console.error('SWIR Runtime/Security Core failed to load',error)}finally{coreLoading=false}
    })();
  }

  function updateLabels(){
    document.title='SWIR OS 1.7 — Neon Core';
    document.querySelectorAll('.boot-subtitle,.topbar-brand span:last-child,.launcher-brand span,.widget-subtitle,.lock-session').forEach(n=>{
      n.innerHTML=n.innerHTML.replace(/1\.6/g,'1.7').replace(/APP SDK: 1\.[345]/g,'APP SDK: 1.6').replace(/App SDK 1\.[345]/g,'App SDK 1.6');
    });
  }

  function addQuickTile(){
    const grid=$('#quick-center .quick-grid');if(!grid||$('#quick-defaults-open'))return;
    const b=document.createElement('button');b.id='quick-defaults-open';b.className='quick-tile';b.type='button';
    b.innerHTML='<strong>DEFAULT APPS <span class="v13-quick-tag">1.7</span></strong><span>File associations & Open With</span>';
    b.addEventListener('click',()=>open('defaults'));grid.appendChild(b);
  }

  function line(text,cls='term-muted'){const out=$('#terminal-output');if(!out)return;const d=document.createElement('div');d.className=cls;d.textContent=text;out.appendChild(d);out.scrollTop=out.scrollHeight}
  function wireTerminal(){
    document.addEventListener('keydown',async e=>{
      const input=e.target;if(!(input instanceof HTMLInputElement)||input.id!=='terminal-input'||e.key!=='Enter')return;
      const raw=input.value.trim(),parts=raw.toLowerCase().split(/\s+/),cmd=parts[0];
      if(!['assoc','defaults','openwith','appdata','filetypes','notifytest','notifications','integrity','trust','installflow','runtime'].includes(cmd))return;
      e.preventDefault();e.stopImmediatePropagation();input.value='';line(`swir@neon-core:~$ ${raw}`,'term-ok');
      const svc=window.SwirAssociations;
      if(cmd==='assoc'||cmd==='filetypes'){
        const exts=svc?.allExtensions?.()||[];
        if(!exts.length){line('No installed file handlers. Install apps from SWIR Store.','term-muted');return}
        exts.forEach(ext=>{const a=svc.defaultFor(ext),count=svc.handlersFor(ext).length;line(`${ext.padEnd(7)} -> ${a?.name||'NO HANDLER'} (${count} handler${count===1?'':'s'})`,a?'term-accent':'term-muted')});return;
      }
      if(cmd==='appdata'){line('Opening SWIR File Explorer. Choose App Data in the sidebar.','term-accent');open('files');return}
      if(cmd==='notifications'){
        const list=window.SwirNotifications?.list?.()||[];line(`APP NOTIFICATION HISTORY: ${list.length} record${list.length===1?'':'s'}`,'term-accent');list.slice(0,8).forEach(n=>line(`${n.appName||n.appId}: ${n.title} — ${n.message}`));return;
      }
      if(cmd==='notifytest'){
        try{await window.SwirNotifications?.send?.('system',{title:'Notification Service',message:'Portable app notification API is online.',tag:'terminal-test'});line('Test notification sent through SWIR Notification Service.','term-accent')}catch(err){line(err?.message||'Notification test failed.','term-error')}return;
      }
      if(cmd==='integrity'){
        const meta=window.SwirPackageIntegrity?.meta;line(meta?`${meta.name} ${meta.version} • ${meta.schema} • SHA-256 + Ed25519`:'Package Integrity service unavailable.',meta?'term-accent':'term-error');return;
      }
      if(cmd==='trust'){
        const info=window.SwirTrustedKeys?.info?.();line(info?`TRUSTED KEY STORE • ${info.total} keys (${info.systemKeys} system / ${info.userKeys} user)`:'Trusted Key Store unavailable.',info?'term-accent':'term-error');return;
      }
      if(cmd==='installflow'){
        const info=window.SwirInstallPipeline?.info?.();line(info?`INSTALL PIPELINE ${info.version} • ${info.stages.join(' -> ')}`:'Install Pipeline unavailable.',info?'term-accent':'term-error');return;
      }
      if(cmd==='runtime'){
        const info=window.SwirRuntime?.info?.();
        if(!info){line('Runtime Adapter unavailable.','term-error');return}
        line(`${info.name} ${info.version} • ${info.contract} • ${info.edition} • ${info.provider}`,'term-accent');
        Object.entries(info.capabilities||{}).forEach(([name,cap])=>line(`${name.padEnd(12)} ${String(cap.provider||'unknown').toUpperCase()} • ${(cap.methods||[]).join(', ')||'no methods'}`));
        return;
      }
      line('Opening Default Apps...','term-accent');open('defaults');
    },true);
  }

  function showStatus(){
    const shell=$('#os-shell');if(!shell||$('#v17-assoc-pill'))return;
    const svc=window.SwirAssociations,total=svc?.allExtensions?.().filter(e=>svc.handlersFor(e).length).length||0;
    const trust=window.SwirTrustedKeys?.info?.();
    const pipe=window.SwirInstallPipeline?.info?.();
    const runtime=window.SwirRuntime?.info?.();
    const el=document.createElement('aside');el.id='v17-assoc-pill';el.className='v16-package-pill';
    el.style.bottom='86px';
    el.innerHTML=`<strong>DESKTOP-READY CORE</strong><span>${runtime?.edition||'WEB'} RUNTIME • SDK 1.6 • ${pipe?'PIPELINE READY':'PIPELINE WAIT'} • ${total} FILE TYPES • ${trust?.total||0} KEYS</span>`;
    el.title='Runtime Adapter Contract 1.0 — terminal command: runtime';
    el.addEventListener('click',()=>open('store'));shell.appendChild(el);
  }

  function init(){
    loadRuntimeCore();
    if(!window.SwirOS||!window.SwirAssociations||!window.SwirNotifications||!window.SwirAppSDK||!window.SwirPackageResolver||!window.SwirRuntime||!window.SwirTrustedKeys||!window.SwirPackageIntegrity||!window.SwirInstallPipeline){setTimeout(init,60);return}
    updateLabels();addQuickTile();wireTerminal();showStatus();
    setTimeout(()=>toast('SWIR OS 1.7','Runtime Adapter Contract, secure install pipeline, publisher trust and portable services are online.'),1300);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
