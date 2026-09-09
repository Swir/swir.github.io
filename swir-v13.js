/* =============================================================
   SWIR OS 1.3 — NEON CORE platform integration
   ============================================================= */
(() => {
  'use strict';
  const $=(s,r=document)=>r.querySelector(s);const $$=(s,r=document)=>[...r.querySelectorAll(s)];
  function open(id){window.SwirOS?.open?.(id)}
  function toast(title,msg){window.SwirOS?.toast?.(title,msg)}
  function app(id){return window.SwirOS?.apps?.find(x=>x.id===id)}

  function addPlatformPill(){
    const shell=$('#os-shell'); if(!shell||$('#v13-platform-pill'))return;
    const info=window.SwirPlatform?.system?.info?.()||{};
    const el=document.createElement('aside'); el.id='v13-platform-pill';
    el.innerHTML=`<div class="v13-platform-copy"><strong>SWIR PLATFORM API</strong><span>EDITION: ${info.edition||'WEB'} • API: ${window.SwirPlatform?.meta?.platformApi||1}</span></div><span class="v13-platform-badge ready">READY</span>`;
    shell.appendChild(el);
  }

  function addQuickTiles(){
    const grid=$('#quick-center .quick-grid'); if(!grid||grid.dataset.v13==='1')return;
    grid.dataset.v13='1';
    grid.insertAdjacentHTML('beforeend',`<button class="quick-tile" data-v13-open="chat" type="button"><strong>SWIR CHAT <span class="v13-quick-tag">LIVE</span></strong><span>Connect to your chat API</span></button><button class="quick-tile" data-v13-open="taskmgr" type="button"><strong>TASK MANAGER <span class="v13-quick-tag">1.3</span></strong><span>Running app processes</span></button><button class="quick-tile" data-v13-open="updates" type="button"><strong>UPDATE CENTER <span class="v13-quick-tag">1.3</span></strong><span>GitHub & runtime updates</span></button><button class="quick-tile" data-v13-open="control" type="button"><strong>PLATFORM CONTROL <span class="v13-quick-tag">API</span></strong><span>Permissions & packages</span></button>`);
    grid.addEventListener('click',e=>{const b=e.target.closest('[data-v13-open]');if(b)open(b.dataset.v13Open)});
  }

  function extendContextMenu(){
    const menu=$('#swir-context-menu'); if(!menu||menu.dataset.v13==='1')return;
    menu.dataset.v13='1';
    const sep=document.createElement('div'); sep.className='ctx-sep'; menu.appendChild(sep);
    [['chat','CH','SWIR Chat'],['taskmgr','▧','Task Manager'],['updates','↻','Update Center'],['control','◇','Platform Control']].forEach(([id,icon,title])=>{
      const b=document.createElement('button');b.className='ctx-item ctx-v13';b.innerHTML=`<span class="ctx-icon">${icon}</span>${title}`;b.addEventListener('click',()=>open(id));menu.appendChild(b);
    });
  }

  function terminalPrint(text,cls='term-muted'){
    const out=$('#terminal-output');if(!out)return;const line=document.createElement('div');line.className=cls;line.textContent=text;out.appendChild(line);out.scrollTop=out.scrollHeight;
  }

  function wireTerminal(){
    document.addEventListener('keydown',e=>{
      const input=e.target;if(!(input instanceof HTMLInputElement)||input.id!=='terminal-input'||e.key!=='Enter')return;
      const raw=input.value.trim();const cmd=raw.toLowerCase().split(/\s+/)[0];
      const map={chat:'chat',msg:'chat',ps:'taskmgr',taskmgr:'taskmgr',update:'updates',updates:'updates',platform:'control',permissions:'control',packages:'control'};
      if(raw.toLowerCase()==='help')setTimeout(()=>terminalPrint('SWIR OS 1.3: chat | ps | taskmgr | update | platform | permissions | packages','term-accent'),25);
      if(cmd==='version'){
        e.stopImmediatePropagation();e.preventDefault();terminalPrint(`swir@neon-core:~$ ${raw}`,'term-ok');terminalPrint('SWIR OS 1.3 / NEON CORE / WEB EDITION','term-accent');input.value='';return;
      }
      if(map[cmd]){
        e.stopImmediatePropagation();e.preventDefault();terminalPrint(`swir@neon-core:~$ ${raw}`,'term-ok');terminalPrint(`Opening ${app(map[cmd])?.title||map[cmd]}...`,'term-accent');input.value='';open(map[cmd]);
      }
    },true);
  }

  function wireShortcuts(){
    document.addEventListener('keydown',e=>{
      if(!e.ctrlKey||!e.altKey)return;
      const k=e.key.toLowerCase();
      if(!e.shiftKey&&k==='h'){e.preventDefault();open('chat');return}
      if(!e.shiftKey)return;
      const map={t:'taskmgr',u:'updates',p:'control'};
      if(map[k]){e.preventDefault();open(map[k])}
    });
  }

  function upgradeLabels(){
    document.title='SWIR OS 1.3 — Neon Core';
    const replacements=[[/NEON CORE \/\/ v1\.[012]/g,'NEON CORE // v1.3'],[/NEON CORE 1\.[012]/g,'NEON CORE 1.3'],[/SWIR OS \/ NEON CORE 1\.[012]/g,'SWIR OS / NEON CORE 1.3'],[/SWIR OS v1\.[012]/g,'SWIR OS v1.3'],[/SWIR OS Terminal v1\.[012]/g,'SWIR OS Terminal v1.3']];
    const updateNode=node=>{
      if(node.nodeType===Node.TEXT_NODE){let t=node.nodeValue;let n=t;replacements.forEach(([a,b])=>n=n.replace(a,b));if(n!==t)node.nodeValue=n;return}
      if(!(node instanceof HTMLElement))return;node.childNodes.forEach(updateNode);
    };
    updateNode(document.body);
    const observer=new MutationObserver(records=>records.forEach(r=>r.addedNodes.forEach(updateNode)));
    observer.observe(document.body,{childList:true,subtree:true});
  }

  function processEvents(){
    const layer=$('#window-layer');if(!layer||!window.SwirPlatform)return;
    const observer=new MutationObserver(()=>window.SwirPlatform.events.emit('process-change',{processes:window.SwirPlatform.processes.list()}));
    observer.observe(layer,{childList:true,subtree:false});
  }

  function init(){
    if(!window.SwirOS||!window.SwirPlatform){setTimeout(init,60);return}
    upgradeLabels();addPlatformPill();addQuickTiles();wireTerminal();wireShortcuts();processEvents();
    setTimeout(extendContextMenu,250);
    setTimeout(()=>toast('SWIR OS','SWIR Chat is ready for first-run API configuration. Retro systems are no longer part of the active environment.'),1400);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(init,0));else setTimeout(init,0);
})();
