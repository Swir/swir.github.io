/* SWIR OS 1.4 — First Boot Setup */
(() => {
  'use strict';
  const $=(s,r=document)=>r.querySelector(s);

  async function waitForPlatform(){
    while(!window.SwirPlatform?.identity||!window.SwirPlatform?.settings) await new Promise(r=>setTimeout(r,60));
    await window.SwirPlatform.ready;
  }

  async function waitForBoot(){
    const boot=$('#boot-screen');
    if(!boot)return;
    while(!boot.classList.contains('boot-hidden')) await new Promise(r=>setTimeout(r,100));
  }

  function safeDeviceName(v){
    return String(v||'').trim().replace(/[^A-Za-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,24);
  }

  function show(){
    if($('#swir-oobe'))return;
    const el=document.createElement('section');el.id='swir-oobe';el.innerHTML=`
      <div class="oobe-card">
        <div class="oobe-kicker">SWIR OS 1.4 // FIRST BOOT</div>
        <div class="oobe-title">Welcome to SWIR OS</div>
        <p class="oobe-lead">Set up this Web Edition device. Your profile and settings stay in this browser. Later Desktop/System editions can map the same Identity API to native accounts.</p>
        <div class="oobe-progress"><span class="active"></span><span class="active"></span><span class="active"></span></div>
        <div class="oobe-grid">
          <div class="oobe-field"><label>DEVICE NAME</label><input id="oobe-device" class="oobe-input" maxlength="24" value="SWIR-WEB"></div>
          <div class="oobe-field"><label>PROFILE NAME</label><input id="oobe-user" class="oobe-input" maxlength="32" value="SWIR"></div>
          <div class="oobe-field"><label>OPTIONAL LOCAL PIN</label><input id="oobe-pin" class="oobe-input" inputmode="numeric" autocomplete="new-password" placeholder="Leave empty for no PIN"></div>
          <div class="oobe-field"><label>COLOR CORE</label><div class="oobe-theme-grid"><button class="oobe-theme active" data-theme="blue" type="button">BLUE</button><button class="oobe-theme" data-theme="green" type="button">GREEN</button><button class="oobe-theme" data-theme="purple" type="button">PURPLE</button></div></div>
        </div>
        <div class="oobe-note">FIRST PROFILE ROLE: CREATOR (local Web profile only)<br>PIN is a convenience lock in Web Edition, not a secure Windows/Linux-class credential.<br>Chat server administration remains separate and uses its own Admin Key.</div>
        <div class="oobe-actions"><div id="oobe-status" class="oobe-status">READY TO CONFIGURE</div><button id="oobe-finish" class="oobe-btn" type="button">FINISH SETUP & ENTER</button></div>
      </div>`;
    document.body.appendChild(el);
    let theme='blue';
    el.addEventListener('click',e=>{const b=e.target.closest('[data-theme]');if(!b)return;theme=b.dataset.theme;el.querySelectorAll('[data-theme]').forEach(x=>x.classList.toggle('active',x===b))});
    $('#oobe-finish').addEventListener('click',async()=>{
      const status=$('#oobe-status'),name=$('#oobe-user').value.trim(),device=safeDeviceName($('#oobe-device').value),pin=$('#oobe-pin').value;
      if(name.length<2){status.textContent='PROFILE NAME MUST HAVE AT LEAST 2 CHARACTERS';status.className='oobe-status bad';return}
      if(device.length<2){status.textContent='DEVICE NAME IS TOO SHORT';status.className='oobe-status bad';return}
      status.textContent='APPLYING SYSTEM CONFIGURATION...';status.className='oobe-status';
      try{
        const p=window.SwirPlatform;const current=await p.identity.active();
        await p.identity.update(current.id,{name,role:'creator',avatar:name.slice(0,2).toUpperCase(),pin});
        await p.identity.setActive(current.id);
        await p.settings.set('device.name',device.toUpperCase());
        await p.settings.set('device.createdAt',Date.now());
        await p.settings.set('oobe.complete',true);
        await p.settings.userSet(current.id,'theme',theme);
        window.SwirOS?.setTheme?.(theme);
        localStorage.setItem('swir-theme',theme);
        status.textContent='SYSTEM CONFIGURED';status.className='oobe-status ok';
        window.postMessage({type:'SWIR_IDENTITY_CHANGED'},location.origin);
        setTimeout(()=>{el.remove();const lock=$('#lock-screen');lock?.classList.add('visible');lock?.setAttribute('aria-hidden','false')},350);
      }catch(err){status.textContent='SETUP FAILED: '+(err?.message||err);status.className='oobe-status bad'}
    });
  }

  async function init(){
    await waitForPlatform();
    const done=await window.SwirPlatform.settings.get('oobe.complete',false);
    if(done)return;
    await waitForBoot();show();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
