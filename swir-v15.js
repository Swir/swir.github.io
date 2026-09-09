/* =============================================================
   SWIR OS 1.5 — DEVICE & NETWORK CORE
   ============================================================= */
(() => {
  'use strict';
  const $=(s,r=document)=>r.querySelector(s);
  const $$=(s,r=document)=>[...r.querySelectorAll(s)];
  const open=id=>window.SwirOS?.open?.(id);
  const toast=(title,msg)=>window.SwirOS?.toast?.(title,msg);
  const platform=()=>window.SwirPlatform;

  async function hostname(){
    try{return await platform().settings.get('device.name','SWIR-WEB')}catch{return'SWIR-WEB'}
  }

  async function renderHostname(){
    const status=$('.topbar-status');if(!status)return;
    let el=$('#v15-hostname');
    if(!el){el=document.createElement('span');el.id='v15-hostname';el.className='hide-mobile v15-hostname';status.insertBefore(el,$('#top-clock'))}
    el.textContent=`HOST: ${(await hostname()).toUpperCase()}`;
  }

  function connection(){return navigator.connection||navigator.mozConnection||navigator.webkitConnection||null}
  function networkLabel(){const c=connection();if(!navigator.onLine)return'OFFLINE';return String(c?.effectiveType||'ONLINE').toUpperCase()}

  function renderNetworkTray(){
    const tray=$('.tray');if(!tray)return;
    let b=$('#v15-network-tray');
    if(!b){b=document.createElement('button');b.id='v15-network-tray';b.type='button';b.title='Network Center';b.innerHTML='<span class="v15-net-dot"></span><span>NET</span>';b.addEventListener('click',()=>open('network'));tray.insertBefore(b,$('#tray-clock'))}
    b.classList.toggle('online',navigator.onLine);b.title=`Network Center — ${networkLabel()}`;
  }

  function addQuickTiles(){
    const grid=$('#quick-center .quick-grid');if(!grid||grid.dataset.v15==='1')return;
    grid.dataset.v15='1';
    const tiles=[['device','DEVICE MANAGER','Hostname & device report'],['network','NETWORK CENTER','Connection & network profiles']];
    tiles.forEach(([id,title,sub])=>{const b=document.createElement('button');b.className='quick-tile';b.type='button';b.innerHTML=`<strong>${title} <span class="v13-quick-tag">1.5</span></strong><span>${sub}</span>`;b.addEventListener('click',()=>open(id));grid.appendChild(b)});
  }

  function terminalLine(text,cls='term-muted'){
    const out=$('#terminal-output');if(!out)return;const d=document.createElement('div');d.className=cls;d.textContent=text;out.appendChild(d);out.scrollTop=out.scrollHeight;
  }

  function wireTerminal(){
    document.addEventListener('keydown',async e=>{
      const input=e.target;if(!(input instanceof HTMLInputElement)||input.id!=='terminal-input'||e.key!=='Enter')return;
      const raw=input.value.trim();const cmd=raw.toLowerCase().split(/\s+/)[0];
      const map={device:'device',devices:'device',devmgr:'device',network:'network',net:'network',netctl:'network',settings:'settings',config:'settings'};
      if(!map[cmd]&&cmd!=='hostname'&&cmd!=='ipconfig')return;
      e.preventDefault();e.stopImmediatePropagation();input.value='';terminalLine(`swir@neon-core:~$ ${raw}`,'term-ok');
      if(cmd==='hostname'){terminalLine((await hostname()).toUpperCase(),'term-accent');return}
      if(cmd==='ipconfig'){
        const c=connection();terminalLine(`STATE=${navigator.onLine?'ONLINE':'OFFLINE'} TYPE=${String(c?.effectiveType||'UNKNOWN').toUpperCase()} DOWNLINK=${c?.downlink??'N/A'}Mbps RTT=${c?.rtt??'N/A'}ms`,'term-accent');return;
      }
      terminalLine(`Opening ${window.SwirOS?.apps?.find(a=>a.id===map[cmd])?.title||map[cmd]}...`,'term-accent');open(map[cmd]);
    },true);
  }

  function wireShortcuts(){
    document.addEventListener('keydown',e=>{
      if(!e.ctrlKey||!e.altKey||e.shiftKey)return;
      const k=e.key.toLowerCase();
      if(k==='d'){e.preventDefault();open('device')}
      if(k==='w'){e.preventDefault();open('network')}
    });
  }

  async function applyUserSettings(){
    try{
      const p=platform();await p.ready;const user=await p.identity.active();if(!user)return;
      const wall=await p.settings.userGet(user.id,'wallpaper',localStorage.getItem('swir-wallpaper')||'grid');
      const reduce=await p.settings.userGet(user.id,'reduceMotion',false);
      $('#os-shell')?.setAttribute('data-wallpaper',wall);
      document.documentElement.classList.toggle('reduce-motion',!!reduce);
    }catch{}
  }

  function updateVersionLabels(){
    document.title='SWIR OS 1.5 — Neon Core';
    const targets=$$('.boot-subtitle,.topbar-brand span:last-child,.launcher-brand span,.widget-subtitle,.lock-session');
    targets.forEach(n=>{n.innerHTML=n.innerHTML.replace(/1\.4/g,'1.5')});
  }

  function wireEvents(){
    addEventListener('online',()=>{renderNetworkTray();toast('Network','Connection restored.')});
    addEventListener('offline',()=>{renderNetworkTray();toast('Network','Offline mode active.')});
    connection()?.addEventListener?.('change',renderNetworkTray);
    addEventListener('message',e=>{
      if(e.origin!==location.origin||!e.data)return;
      if(e.data.type==='SWIR_DEVICE_CHANGED'){renderHostname();toast('Device','Hostname updated.')}
      if(e.data.type==='SWIR_NETWORK_CHANGED'){renderNetworkTray();toast('Network','Network profile updated.')}
      if(e.data.type==='SWIR_SETTINGS_CHANGED'){renderHostname();renderNetworkTray();applyUserSettings();toast('Settings','System preferences applied.')}
    });
  }

  async function init(){
    if(!platform()||!window.SwirOS){setTimeout(init,60);return}
    await platform().ready;updateVersionLabels();await renderHostname();renderNetworkTray();addQuickTiles();wireTerminal();wireShortcuts();wireEvents();await applyUserSettings();
    setTimeout(()=>toast('SWIR OS 1.5','Device Manager, Network Center and System Settings are online.'),1500);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(init,0));else setTimeout(init,0);
})();
