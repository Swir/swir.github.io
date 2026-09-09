/* =============================================================
   SWIR OS 1.4 — IDENTITY & SESSION CORE
   ============================================================= */
(() => {
  'use strict';
  const $=(s,r=document)=>r.querySelector(s);
  const $$=(s,r=document)=>[...r.querySelectorAll(s)];
  let activeUser=null;

  const open=id=>window.SwirOS?.open?.(id);
  const toast=(title,msg)=>window.SwirOS?.toast?.(title,msg);
  const identity=()=>window.SwirPlatform?.identity;

  function cleanUser(user){
    if(!user)return null;
    return {id:user.id,name:user.name,role:user.role,avatar:user.avatar,accent:user.accent,pinEnabled:!!user.pinEnabled,lastLoginAt:user.lastLoginAt};
  }

  async function loadActive(){
    if(!identity())return null;
    await window.SwirPlatform.ready;
    activeUser=cleanUser(await identity().active());
    return activeUser;
  }

  function roleLabel(user){return `${String(user?.role||'user').toUpperCase()} SESSION`}

  async function renderShellIdentity(){
    const user=await loadActive();if(!user)return;
    const foot=$('#launcher .launcher-foot span:first-child');if(foot)foot.textContent=`USER: ${user.name}`;
    $$('.topbar-status .v14-access').forEach(x=>x.remove());
    const status=$('.topbar-status');
    if(status){
      const el=document.createElement('span');el.className='hide-mobile v14-access';el.textContent=`USER: ${user.name.toUpperCase()} / ${user.role.toUpperCase()}`;status.insertBefore(el,$('#top-clock'));
    }
    const existing=$('#v14-user-tray');if(existing)existing.remove();
    const tray=$('.tray');
    if(tray){
      const b=document.createElement('button');b.id='v14-user-tray';b.type='button';b.title='User Manager';
      b.innerHTML=`<span class="v14-avatar">${String(user.avatar||user.name.slice(0,2)).toUpperCase()}</span><span class="v14-name">${user.name}</span>`;
      b.addEventListener('click',()=>open('users'));
      tray.insertBefore(b,$('#tray-clock'));
    }
  }

  async function renderLock(){
    const api=identity();if(!api)return;
    const users=await api.list();const current=cleanUser(await api.active());activeUser=current;
    const login=$('#lock-screen .lock-login');if(!login||!current)return;
    const avatar=$('.lock-avatar',login),name=$('.lock-user strong',login),role=$('.lock-user span',login),session=$('.lock-session',login),unlock=$('#unlock-os',login);
    if(avatar)avatar.textContent=String(current.avatar||current.name.slice(0,2)).toUpperCase();
    if(name)name.textContent=current.name;
    if(role)role.textContent=roleLabel(current);
    if(session)session.innerHTML=`ACCESS LEVEL: ${current.role.toUpperCase()}<br>CORE: NEON 1.4<br>EDITION: WEB<br>IDENTITY: LOCAL PROFILE`;
    let select=$('#v14-lock-user',login);
    if(!select){select=document.createElement('select');select.id='v14-lock-user';select.className='v14-lock-select';session?.insertAdjacentElement('afterend',select)}
    select.innerHTML=users.map(u=>`<option value="${u.id}" ${u.id===current.id?'selected':''}>${u.name} — ${u.role.toUpperCase()}</option>`).join('');
    select.onchange=async()=>{await api.setActive(select.value);await renderLock();await renderShellIdentity()};
    let pin=$('#v14-pin',login);
    if(!pin){pin=document.createElement('input');pin.id='v14-pin';pin.className='v14-pin';pin.type='password';pin.inputMode='numeric';pin.autocomplete='current-password';pin.placeholder='ENTER LOCAL PIN';select.insertAdjacentElement('afterend',pin)}
    pin.style.display=current.pinEnabled?'block':'none';pin.value='';
    pin.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();unlock?.click()}};
    let auth=$('#v14-auth-status',login);
    if(!auth){auth=document.createElement('div');auth.id='v14-auth-status';auth.className='v14-auth-status';pin.insertAdjacentElement('afterend',auth)}
    auth.textContent=current.pinEnabled?'PIN REQUIRED':'PROFILE READY';auth.className='v14-auth-status';
    if(unlock)unlock.textContent=current.pinEnabled?'> AUTHENTICATE & ENTER':'> ACCESS SWIR OS';
  }

  function manualUnlock(user){
    const el=$('#lock-screen');if(!el)return;
    try{const a=new Audio('./ding.mp3');a.volume=.2;a.play().catch(()=>{})}catch{}
    el.classList.remove('visible');el.setAttribute('aria-hidden','true');
    localStorage.setItem('swir-last-unlock',String(Date.now()));
    toast('Session unlocked',`${user.name} // ${user.role.toUpperCase()} access granted.`);
    const pending=new URLSearchParams(location.search).get('app');
    if(pending&&window.SwirOS?.apps?.some(a=>a.id===pending)){setTimeout(()=>open(pending),220);try{history.replaceState({},'',location.pathname)}catch{}}
  }

  async function authenticateAndUnlock(event){
    const target=event.target.closest?.('#unlock-os');if(!target)return;
    const user=await loadActive();if(!user)return;
    if(!user.pinEnabled){
      identity().authenticate(user.id,'').then(()=>renderShellIdentity()).catch(()=>{});
      return;
    }
    event.preventDefault();event.stopImmediatePropagation();
    const pin=$('#v14-pin')?.value||'';const status=$('#v14-auth-status');
    if(status){status.textContent='VERIFYING...';status.className='v14-auth-status'}
    const result=await identity().authenticate(user.id,pin);
    if(!result.ok){
      if(status){status.textContent='ACCESS DENIED — INVALID PIN';status.className='v14-auth-status bad'}
      $('#v14-pin')?.focus();return;
    }
    if(status){status.textContent='ACCESS GRANTED';status.className='v14-auth-status ok'}
    manualUnlock(cleanUser(result.user));renderShellIdentity();
  }

  function observeLocks(){
    const lock=$('#lock-screen');if(!lock)return;
    new MutationObserver(async()=>{
      if(lock.classList.contains('visible')){
        try{await identity()?.lock?.()}catch{}
        renderLock();
      }
    }).observe(lock,{attributes:true,attributeFilter:['class']});
  }

  function addQuickUserTile(){
    const grid=$('#quick-center .quick-grid');if(!grid||$('#quick-users-open'))return;
    const b=document.createElement('button');b.id='quick-users-open';b.className='quick-tile';b.type='button';b.innerHTML='<strong>USER MANAGER <span class="v13-quick-tag">1.4</span></strong><span>Profiles, roles & local PIN</span>';b.addEventListener('click',()=>open('users'));grid.appendChild(b);
  }

  function wireUserShortcut(){
    document.addEventListener('keydown',e=>{
      if(e.ctrlKey&&e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='u'){e.preventDefault();open('users')}
    });
  }

  function terminalLine(text,cls='term-muted'){
    const out=$('#terminal-output');if(!out)return;const d=document.createElement('div');d.className=cls;d.textContent=text;out.appendChild(d);out.scrollTop=out.scrollHeight;
  }

  function wireTerminal(){
    document.addEventListener('keydown',async e=>{
      const input=e.target;if(!(input instanceof HTMLInputElement)||input.id!=='terminal-input'||e.key!=='Enter')return;
      const raw=input.value.trim();const cmd=raw.toLowerCase().split(/\s+/)[0];
      if(!['whoami','users','userctl','session','logout'].includes(cmd))return;
      e.preventDefault();e.stopImmediatePropagation();input.value='';terminalLine(`swir@neon-core:~$ ${raw}`,'term-ok');
      const user=await loadActive();
      if(cmd==='whoami'){terminalLine(`${user?.name||'UNKNOWN'} // ROLE=${String(user?.role||'unknown').toUpperCase()} // PROFILE=${user?.id||'-'}`,'term-accent');return}
      if(cmd==='session'){const s=await identity().session();terminalLine(`USER=${s.user?.name||'-'} LOCKED=${s.locked?'YES':'NO'} STARTED=${s.startedAt?new Date(s.startedAt).toLocaleString():'-'}`,'term-accent');return}
      if(cmd==='logout'){
        await identity().lock();const lock=$('#lock-screen');lock?.classList.add('visible');lock?.setAttribute('aria-hidden','false');await renderLock();terminalLine('Session locked.','term-accent');return;
      }
      terminalLine('Opening User Manager...','term-accent');open('users');
    },true);
  }

  async function enhanceChatFrame(frame){
    try{
      const doc=frame.contentDocument;if(!doc)return;const nick=doc.querySelector('#nickname');const user=await loadActive();
      if(nick&&user&&!nick.value.trim())nick.value=user.name;
    }catch{}
  }

  function watchChatFrames(){
    const layer=$('#window-layer');if(!layer)return;
    const attach=frame=>{
      if(!(frame instanceof HTMLIFrameElement)||frame.dataset.v14Identity==='1')return;
      const path=(()=>{try{return new URL(frame.src,location.href).pathname.toLowerCase()}catch{return''}})();
      if(!path.endsWith('/swir-chat.html'))return;
      frame.dataset.v14Identity='1';frame.addEventListener('load',()=>enhanceChatFrame(frame));setTimeout(()=>enhanceChatFrame(frame),80);
    };
    layer.querySelectorAll('iframe').forEach(attach);
    new MutationObserver(rs=>rs.forEach(r=>r.addedNodes.forEach(n=>{if(n instanceof HTMLIFrameElement)attach(n);if(n instanceof Element)n.querySelectorAll?.('iframe').forEach(attach)}))).observe(layer,{childList:true,subtree:true});
  }

  function updateVersionLabels(){
    document.title='SWIR OS 1.4 — Neon Core';
    const nodes=[...document.querySelectorAll('.boot-subtitle,.topbar-brand span:last-child,.launcher-brand span,.widget-subtitle,.lock-session')];
    nodes.forEach(n=>{n.innerHTML=n.innerHTML.replace(/1\.3/g,'1.4')});
  }

  async function identityChanged(){await renderShellIdentity();await renderLock();document.querySelectorAll('iframe').forEach(f=>{try{if(new URL(f.src,location.href).pathname.toLowerCase().endsWith('/swir-users.html'))f.contentWindow?.postMessage({type:'SWIR_IDENTITY_REFRESH'},location.origin)}catch{}})}

  function wireMessages(){window.addEventListener('message',e=>{if(e.origin!==location.origin||!e.data)return;if(e.data.type==='SWIR_IDENTITY_CHANGED')identityChanged()})}

  async function init(){
    if(!window.SwirPlatform||!window.SwirOS){setTimeout(init,60);return}
    await window.SwirPlatform.ready;updateVersionLabels();await renderShellIdentity();await renderLock();observeLocks();addQuickUserTile();wireUserShortcut();wireTerminal();wireMessages();watchChatFrames();
    document.addEventListener('click',authenticateAndUnlock,true);
    setTimeout(()=>toast('SWIR OS 1.4','Identity & Session Core online. Local profiles, roles, PIN and user-aware apps are ready.'),1500);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(init,0));else setTimeout(init,0);
})();
