/* SWIR OS 1.7 — Files & Associations integration */
(() => {
  'use strict';
  const $=(s,r=document)=>r.querySelector(s);
  const open=id=>window.SwirOS?.open?.(id);
  const toast=(t,m)=>window.SwirOS?.toast?.(t,m);

  function updateLabels(){
    document.title='SWIR OS 1.7 — Neon Core';
    document.querySelectorAll('.boot-subtitle,.topbar-brand span:last-child,.launcher-brand span,.widget-subtitle,.lock-session').forEach(n=>{
      n.innerHTML=n.innerHTML.replace(/1\.6/g,'1.7');
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
    document.addEventListener('keydown',e=>{
      const input=e.target;if(!(input instanceof HTMLInputElement)||input.id!=='terminal-input'||e.key!=='Enter')return;
      const raw=input.value.trim(),parts=raw.toLowerCase().split(/\s+/),cmd=parts[0];
      if(!['assoc','defaults','openwith','appdata','filetypes'].includes(cmd))return;
      e.preventDefault();e.stopImmediatePropagation();input.value='';line(`swir@neon-core:~$ ${raw}`,'term-ok');
      const svc=window.SwirAssociations;
      if(cmd==='assoc'||cmd==='filetypes'){
        const exts=svc?.allExtensions?.()||[];
        if(!exts.length){line('No installed file handlers. Install apps from SWIR Store.','term-muted');return}
        exts.forEach(ext=>{const a=svc.defaultFor(ext),count=svc.handlersFor(ext).length;line(`${ext.padEnd(7)} -> ${a?.name||'NO HANDLER'} (${count} handler${count===1?'':'s'})`,a?'term-accent':'term-muted')});return;
      }
      if(cmd==='appdata'){line('Opening SWIR File Explorer. Choose App Data in the sidebar.','term-accent');open('files');return}
      line('Opening Default Apps...','term-accent');open('defaults');
    },true);
  }

  function showStatus(){
    const shell=$('#os-shell');if(!shell||$('#v17-assoc-pill'))return;
    const svc=window.SwirAssociations,total=svc?.allExtensions?.().filter(e=>svc.handlersFor(e).length).length||0;
    const el=document.createElement('aside');el.id='v17-assoc-pill';el.className='v16-package-pill';
    el.style.bottom='86px';
    el.innerHTML=`<strong>FILE ASSOCIATIONS</strong><span>${total} ACTIVE TYPES • OPEN WITH READY</span>`;
    el.addEventListener('click',()=>open('defaults'));shell.appendChild(el);
  }

  function init(){
    if(!window.SwirOS||!window.SwirAssociations||!window.SwirAppSDK){setTimeout(init,60);return}
    updateLabels();addQuickTile();wireTerminal();showStatus();
    setTimeout(()=>toast('SWIR OS 1.7','Files & Associations online. Double-click files in Explorer or use Open With.'),1300);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
