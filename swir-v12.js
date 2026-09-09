/* =============================================================
   SWIR OS v1.2 — NEON CORE desktop extension
   Context menu, system shortcuts, terminal commands, network state
   and integration for File Explorer / Notes / Calculator / Player.
   ============================================================= */
(() => {
  'use strict';
  const $=(s,r=document)=>r.querySelector(s);const $$=(s,r=document)=>[...r.querySelectorAll(s)];
  const VFS_KEY='swir-vfs-v12';
  let context=null;
  function app(id){return window.SwirOS?.apps?.find(x=>x.id===id)}
  function open(id){window.SwirOS?.open?.(id)}
  function toast(title,msg){window.SwirOS?.toast?.(title,msg)}
  function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function readVFS(){try{const v=JSON.parse(localStorage.getItem(VFS_KEY)||'[]');return Array.isArray(v)?v:[]}catch{return[]}}
  function writeVFS(v){localStorage.setItem(VFS_KEY,JSON.stringify(v))}
  function uid(){return 'f-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7)}

  function createContextMenu(){
    const el=document.createElement('div');el.id='swir-context-menu';el.setAttribute('role','menu');
    el.innerHTML=`<div class="ctx-head">SWIR OS // DESKTOP</div>
      <button class="ctx-item" data-ctx="files"><span class="ctx-icon">▤</span>File Explorer<span class="ctx-key">CTRL+ALT+E</span></button>
      <button class="ctx-item" data-ctx="notes"><span class="ctx-icon">N</span>New Note<span class="ctx-key">CTRL+ALT+N</span></button>
      <button class="ctx-item" data-ctx="folder"><span class="ctx-icon">▰</span>New virtual folder</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-ctx="calc"><span class="ctx-icon">±</span>Calculator<span class="ctx-key">CTRL+ALT+C</span></button>
      <button class="ctx-item" data-ctx="player"><span class="ctx-icon">▶</span>SWIR Player<span class="ctx-key">CTRL+ALT+M</span></button>
      <button class="ctx-item" data-ctx="monitor"><span class="ctx-icon">▥</span>System Monitor<span class="ctx-key">CTRL+ALT+S</span></button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-ctx="personalize"><span class="ctx-icon">⚙</span>Personalize</button>
      <button class="ctx-item" data-ctx="arrange"><span class="ctx-icon">▦</span>Arrange icons</button>
      <button class="ctx-item" data-ctx="refresh"><span class="ctx-icon">↻</span>Refresh</button>
      <button class="ctx-item" data-ctx="lock"><span class="ctx-icon">◆</span>Lock session<span class="ctx-key">CTRL+SHIFT+L</span></button>`;
    document.body.appendChild(el);context=el;
    el.addEventListener('click',e=>{const b=e.target.closest('[data-ctx]');if(!b)return;handleContext(b.dataset.ctx);hideContext()});
  }
  function showContext(x,y){if(!context)return;context.classList.add('open');const r=context.getBoundingClientRect();context.style.left=Math.max(8,Math.min(x,innerWidth-r.width-8))+'px';context.style.top=Math.max(8,Math.min(y,innerHeight-r.height-8))+'px'}
  function hideContext(){context?.classList.remove('open')}
  function newFolder(){const name=prompt('Virtual folder name:','New Folder');if(!name?.trim())return;const items=readVFS();items.push({id:uid(),type:'folder',name:name.trim(),parent:'root',trashed:false,created:Date.now()});writeVFS(items);toast('File Explorer',`Folder “${name.trim()}” created in Documents.`);open('files')}
  function handleContext(action){
    const map={files:'files',notes:'notes',calc:'calc',player:'player',monitor:'monitor',personalize:'settings'};
    if(map[action])return open(map[action]);if(action==='folder')return newFolder();if(action==='arrange'){localStorage.removeItem('swir-icon-positions');toast('Desktop','Icon layout reset. Reloading desktop...');setTimeout(()=>location.reload(),350)}if(action==='refresh')location.reload();if(action==='lock')$('#quick-lock')?.click();
  }

  function wireContext(){
    createContextMenu();
    $('#os-shell')?.addEventListener('contextmenu',e=>{
      if(matchMedia('(max-width:760px)').matches)return;
      if(e.target.closest('.os-window,.launcher,.taskbar,.v11-side-panel,#lock-screen,#boot-screen'))return;
      e.preventDefault();showContext(e.clientX,e.clientY);
    });
    document.addEventListener('pointerdown',e=>{if(context?.classList.contains('open')&&!e.target.closest('#swir-context-menu'))hideContext()});
    window.addEventListener('blur',hideContext);window.addEventListener('resize',hideContext);
  }

  function addStatusPill(){
    const shell=$('#os-shell');if(!shell||$('#v12-status-pill'))return;const box=document.createElement('aside');box.id='v12-status-pill';box.innerHTML=`<div class="v12-status-copy"><strong>NEON CORE 1.2</strong><span id="v12-net-text">NETWORK: CHECKING...</span></div><span id="v12-net-dot" class="v12-status-dot"></span>`;shell.appendChild(box);updateNetworkStatus(false)
  }
  function updateNetworkStatus(announce=true){const online=navigator.onLine;const text=$('#v12-net-text'),dot=$('#v12-net-dot');if(text)text.textContent=`NETWORK: ${online?'ONLINE':'OFFLINE'} • STORAGE: LOCAL`;dot?.classList.toggle('offline',!online);if(announce)toast('Network',online?'Connection restored.':'You are offline. Cached SWIR OS modules may still work.')}

  function addQuickTiles(){const grid=$('#quick-center .quick-grid');if(!grid||grid.dataset.v12==='1')return;grid.dataset.v12='1';const html=`<button class="quick-tile" data-v12-open="files" type="button"><strong>FILE EXPLORER</strong><span>Virtual files & Trash</span></button><button class="quick-tile" data-v12-open="notes" type="button"><strong>NOTES</strong><span>Autosaving local notes</span></button><button class="quick-tile" data-v12-open="player" type="button"><strong>SWIR PLAYER</strong><span>Local audio player</span></button><button class="quick-tile" data-v12-open="monitor" type="button"><strong>MONITOR</strong><span>Browser telemetry</span></button>`;grid.insertAdjacentHTML('beforeend',html)}

  function wireMessages(){window.addEventListener('message',e=>{if(e.origin!==location.origin||!e.data)return;if(e.data.type==='SWIR_V12_OPEN_APP'&&app(e.data.id))open(e.data.id)})}

  function printTerminal(text,cls='term-muted'){const out=$('#terminal-output');if(!out)return;const line=document.createElement('div');line.className=cls;line.textContent=text;out.appendChild(line);out.scrollTop=out.scrollHeight}
  function wireTerminalCommands(){
    document.addEventListener('keydown',e=>{
      const input=e.target;if(!(input instanceof HTMLInputElement)||input.id!=='terminal-input'||e.key!=='Enter')return;
      const raw=input.value.trim();const cmd=raw.toLowerCase().split(/\s+/)[0];
      const custom={files:'files',explorer:'files',notes:'notes',calc:'calc',calculator:'calc',music:'player',player:'player',monitor:'monitor',sysinfo:'monitor',store:'store'};
      if(raw.toLowerCase()==='help'){setTimeout(()=>{printTerminal('SWIR OS 1.2 commands: files | notes | calc | player | monitor | lock','term-accent')},20);return}
      if(cmd==='lock'){e.stopImmediatePropagation();e.preventDefault();printTerminal(`swir@neon-core:~$ ${raw}`,'term-ok');printTerminal('Locking creator session...','term-accent');input.value='';$('#quick-lock')?.click();return}
      if(custom[cmd]){e.stopImmediatePropagation();e.preventDefault();printTerminal(`swir@neon-core:~$ ${raw}`,'term-ok');printTerminal(`Opening ${app(custom[cmd])?.title||custom[cmd]}...`,'term-accent');input.value='';open(custom[cmd])}
    },true)
  }

  function wireShortcuts(){document.addEventListener('keydown',e=>{if(!e.ctrlKey||!e.altKey)return;const k=e.key.toLowerCase();const map={e:'files',n:'notes',c:'calc',m:'player',s:'monitor'};if(map[k]){e.preventDefault();open(map[k])}})}
  function markNewApps(){setTimeout(()=>{['files','notes','calc','player','monitor'].forEach(id=>{const icon=$(`#desktop-icons .desktop-icon[data-open="${id}"]`);icon?.classList.add('v12-new-app')})},120)}

  function init(){if(!window.SwirOS){setTimeout(init,50);return}document.title='SWIR OS 1.2 — Neon Core';addQuickTiles();addStatusPill();wireContext();wireMessages();wireTerminalCommands();wireShortcuts();markNewApps();window.addEventListener('online',()=>updateNetworkStatus(true));window.addEventListener('offline',()=>updateNetworkStatus(true));setTimeout(()=>toast('SWIR OS 1.2','File Explorer, Notes, Calculator, Player and System Monitor are online.'),1200)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(init,0));else setTimeout(init,0);
})();
