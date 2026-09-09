/* =============================================================
   SWIR OS v1.1 — NEON CORE / corrected runtime
   ============================================================= */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const readJSON = (k, f) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? f; } catch { return f; } };
  const esc = (v = '') => String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

  const state = {
    wallpaper: localStorage.getItem('swir-wallpaper') || 'grid',
    notifications: readJSON('swir-notifications', []),
    positions: readJSON('swir-icon-positions', {}),
    unread: 0,
    panel: null,
    installPrompt: null,
    pendingApp: new URLSearchParams(location.search).get('app') || ''
  };

  const app = id => window.SwirOS?.apps?.find(a => a.id === id) || null;
  const chime = () => {
    if (localStorage.getItem('swir-sound') === 'off') return;
    try { const a = new Audio('./ding.mp3'); a.volume = .22; a.play().catch(() => {}); } catch {}
  };
  const toast = (title, message) => window.SwirOS?.toast ? window.SwirOS.toast(title, message) : addNotification(title, message);

  /* wallpaper */
  function setWallpaper(name, announce = false) {
    const allowed = ['grid', 'aurora', 'void'];
    state.wallpaper = allowed.includes(name) ? name : 'grid';
    localStorage.setItem('swir-wallpaper', state.wallpaper);
    $('#os-shell')?.setAttribute('data-wallpaper', state.wallpaper);
    $$('.wallpaper-pill').forEach(b => b.classList.toggle('active', b.dataset.wallpaper === state.wallpaper));
    if (announce) toast('Wallpaper', `${state.wallpaper.toUpperCase()} wallpaper activated.`);
  }

  /* lock screen */
  function updateLockClock() {
    const now = new Date();
    if ($('#lock-clock')) $('#lock-clock').textContent = now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    if ($('#lock-date')) $('#lock-date').textContent = now.toLocaleDateString([], {weekday:'long', day:'2-digit', month:'long', year:'numeric'});
  }

  function lock() {
    closePanels();
    updateLockClock();
    const el = $('#lock-screen');
    if (!el) return;
    el.classList.add('visible');
    el.setAttribute('aria-hidden', 'false');
    setTimeout(() => $('#unlock-os')?.focus(), 120);
  }

  function unlock() {
    const el = $('#lock-screen');
    if (!el) return;
    chime();
    el.classList.remove('visible');
    el.setAttribute('aria-hidden', 'true');
    localStorage.setItem('swir-last-unlock', String(Date.now()));
    toast('Session unlocked', 'SWIR // CREATOR access granted.');
    if (state.pendingApp && app(state.pendingApp)) {
      const id = state.pendingApp;
      state.pendingApp = '';
      setTimeout(() => window.SwirOS?.open?.(id), 260);
      try { history.replaceState({}, '', location.pathname); } catch {}
    }
  }

  function initLock() {
    $('#unlock-os')?.addEventListener('click', unlock);
    const boot = $('#boot-screen');
    if (!boot) return lock();
    const watcher = new MutationObserver(() => {
      if (boot.classList.contains('boot-hidden')) setTimeout(lock, 240);
    });
    watcher.observe(boot, {attributes:true, attributeFilter:['class']});
    if (boot.classList.contains('boot-hidden')) lock();
  }

  /* notifications */
  function saveNotifications() {
    state.notifications = state.notifications.slice(0, 20);
    localStorage.setItem('swir-notifications', JSON.stringify(state.notifications));
  }

  function addNotification(title, message) {
    state.notifications.unshift({title:String(title || 'SWIR OS'), message:String(message || 'System event'), time:new Date().toISOString()});
    state.unread++;
    saveNotifications();
    renderNotifications();
    updateBadge();
  }

  function renderNotifications() {
    const host = $('#notification-list');
    if (!host) return;
    if (!state.notifications.length) {
      host.innerHTML = '<div class="notification-empty">NO NEW SIGNALS<br>Notification history is empty.</div>';
      return;
    }
    host.innerHTML = state.notifications.map(n => {
      const d = new Date(n.time);
      const t = Number.isNaN(d.getTime()) ? 'SYSTEM' : d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      return `<article class="notification-item"><strong>${esc(n.title)}</strong><p>${esc(n.message)}</p><time>${esc(t)}</time></article>`;
    }).join('');
  }

  function updateBadge() {
    const b = $('#notification-badge');
    if (b) b.textContent = state.unread ? (state.unread > 9 ? '9+' : String(state.unread)) : '';
  }

  function observeCoreToasts() {
    const stack = $('#toast-stack');
    if (!stack) return;
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement) || !node.classList.contains('toast')) continue;
        addNotification($('strong', node)?.textContent?.trim() || 'SWIR OS', $('span', node)?.textContent?.trim() || 'System event');
      }
    }).observe(stack, {childList:true});
  }

  /* panels */
  function closePanels() {
    state.panel = null;
    $('#notification-center')?.classList.remove('open');
    $('#quick-center')?.classList.remove('open');
    $('#v11-panel-backdrop')?.classList.remove('open');
    $('#notification-button')?.classList.remove('active');
    $('#quick-button')?.classList.remove('active');
  }

  function refreshQuick() {
    const theme = document.documentElement.dataset.theme || 'blue';
    $$('.v11-theme-pill').forEach(b => b.classList.toggle('active', b.dataset.v11Theme === theme));
    $$('.wallpaper-pill').forEach(b => b.classList.toggle('active', b.dataset.wallpaper === state.wallpaper));
  }

  function togglePanel(name) {
    if (state.panel === name) return closePanels();
    closePanels();
    state.panel = name;
    $('#v11-panel-backdrop')?.classList.add('open');
    if (name === 'notifications') {
      $('#notification-center')?.classList.add('open');
      $('#notification-button')?.classList.add('active');
      state.unread = 0; updateBadge(); renderNotifications();
    } else {
      $('#quick-center')?.classList.add('open');
      $('#quick-button')?.classList.add('active');
      refreshQuick();
    }
  }

  function wirePanels() {
    $('#notification-button')?.addEventListener('click', () => togglePanel('notifications'));
    $('#quick-button')?.addEventListener('click', () => togglePanel('quick'));
    $('#v11-panel-backdrop')?.addEventListener('click', closePanels);
    $('#clear-notifications')?.addEventListener('click', () => {
      state.notifications = []; state.unread = 0; saveNotifications(); renderNotifications(); updateBadge();
    });
    $$('.v11-theme-pill').forEach(b => b.addEventListener('click', () => {
      window.SwirOS?.setTheme?.(b.dataset.v11Theme); refreshQuick(); chime(); toast('Color core', `${b.dataset.v11Theme.toUpperCase()} core activated.`);
    }));
    $$('.wallpaper-pill').forEach(b => b.addEventListener('click', () => setWallpaper(b.dataset.wallpaper, true)));
    $('#quick-settings-open')?.addEventListener('click', () => { closePanels(); window.SwirOS?.open?.('settings'); });
    $('#quick-store-open')?.addEventListener('click', () => { closePanels(); window.SwirOS?.open?.('store'); });
    $('#quick-lock')?.addEventListener('click', lock);
    $('#quick-reset-icons')?.addEventListener('click', () => {
      state.positions = {}; localStorage.removeItem('swir-icon-positions'); layoutIcons(true); toast('Desktop', 'Icon positions restored.');
    });
    $('#quick-install')?.addEventListener('click', async () => {
      if (!state.installPrompt) return toast('Install SWIR OS', 'Use your browser menu → Add to Home screen / Install app if the install prompt is unavailable.');
      state.installPrompt.prompt();
      try { await state.installPrompt.userChoice; } catch {}
      state.installPrompt = null; updateInstallTile();
    });
  }

  /* desktop shortcuts + drag */
  const installed = () => { const v = readJSON('swir-installed-apps', []); return Array.isArray(v) ? v : []; };

  function iconHTML(a) {
    return `<span class="app-glyph" style="--glyph-color:${esc(a.accent || '#00c8ff')}">${esc(a.icon || '◆')}</span><span class="desktop-icon-label">${esc(a.title)}</span>`;
  }

  function syncInstalled() {
    const host = $('#desktop-icons');
    if (!host || !window.SwirOS?.apps) return;
    const list = installed();
    $$(".desktop-icon[data-installed-shortcut='1']", host).forEach(b => { if (!list.includes(b.dataset.open)) b.remove(); });
    for (const id of list) {
      const a = app(id); if (!a) continue;
      if ($$('.desktop-icon', host).some(b => b.dataset.open === id)) continue;
      const b = document.createElement('button');
      b.className = 'desktop-icon'; b.dataset.open = id; b.dataset.installedShortcut = '1'; b.title = a.subtitle || a.title; b.innerHTML = iconHTML(a); host.appendChild(b);
    }
    layoutIcons();
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(v, b));
  const fallbackPos = i => ({x: Math.floor(i / 6) * 98, y: (i % 6) * 92});

  function layoutIcons(force = false) {
    const host = $('#desktop-icons'); if (!host) return;
    const mobile = matchMedia('(max-width: 760px)').matches;
    host.classList.toggle('swir-free-layout', !mobile);
    if (mobile) return;
    const maxX = Math.max(0, host.clientWidth - 90), maxY = Math.max(0, host.clientHeight - 92);
    $$('.desktop-icon', host).forEach((b, i) => {
      const p = (!force && state.positions[b.dataset.open]) || fallbackPos(i);
      b.style.left = `${clamp(Number(p.x) || 0, 0, maxX)}px`;
      b.style.top = `${clamp(Number(p.y) || 0, 0, maxY)}px`;
      enableDrag(b);
    });
  }

  function enableDrag(button) {
    if (button.dataset.swirDragReady === '1') return;
    button.dataset.swirDragReady = '1';
    let d = null;
    button.addEventListener('pointerdown', e => {
      if (matchMedia('(max-width: 760px)').matches || e.button !== 0) return;
      const host = $('#desktop-icons'), br = button.getBoundingClientRect(), hr = host.getBoundingClientRect();
      d = {id:e.pointerId, sx:e.clientX, sy:e.clientY, dx:e.clientX-br.left, dy:e.clientY-br.top, hr, moved:false};
      button.setPointerCapture?.(e.pointerId);
    });
    button.addEventListener('pointermove', e => {
      if (!d || d.id !== e.pointerId) return;
      if (Math.hypot(e.clientX-d.sx, e.clientY-d.sy) > 5) d.moved = true;
      if (!d.moved) return;
      e.preventDefault(); button.classList.add('dragging');
      const host = $('#desktop-icons');
      button.style.left = `${clamp(e.clientX-d.hr.left-d.dx, 0, Math.max(0, host.clientWidth-button.offsetWidth))}px`;
      button.style.top = `${clamp(e.clientY-d.hr.top-d.dy, 0, Math.max(0, host.clientHeight-button.offsetHeight))}px`;
    });
    const end = e => {
      if (!d || d.id !== e.pointerId) return;
      const moved = d.moved; d = null; button.classList.remove('dragging');
      if (!moved) return;
      button.dataset.justDragged = '1';
      state.positions[button.dataset.open] = {x:parseFloat(button.style.left)||0, y:parseFloat(button.style.top)||0};
      localStorage.setItem('swir-icon-positions', JSON.stringify(state.positions));
      setTimeout(() => delete button.dataset.justDragged, 260);
    };
    button.addEventListener('pointerup', end); button.addEventListener('pointercancel', end);
  }

  function clickGuard() {
    document.addEventListener('click', e => {
      if (!e.target.closest(".desktop-icon[data-just-dragged='1']")) return;
      e.preventDefault(); e.stopImmediatePropagation();
    }, true);
  }

  /* store bridge */
  function wireStore() {
    window.addEventListener('message', e => {
      if (e.origin !== location.origin || !e.data) return;
      const {type, id} = e.data, a = app(id); if (!a) return;
      if (type === 'SWIR_STORE_OPEN') return window.SwirOS?.open?.(id);
      if (type === 'SWIR_STORE_INSTALL') { syncInstalled(); toast('SWIR Store', `${a.title} shortcut installed.`); }
      if (type === 'SWIR_STORE_REMOVE') {
        if (!a.desktop) $$('#desktop-icons .desktop-icon').find(b => b.dataset.open === id && b.dataset.installedShortcut === '1')?.remove();
        delete state.positions[id]; localStorage.setItem('swir-icon-positions', JSON.stringify(state.positions)); layoutIcons(); toast('SWIR Store', `${a.title} shortcut removed.`);
      }
    });
  }

  /* PWA */
  function updateInstallTile() {
    const span = $('#quick-install span'); if (span) span.textContent = state.installPrompt ? 'Install as an app' : 'Browser menu also works';
  }

  function initPWA() {
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); state.installPrompt = e; updateInstallTile(); toast('SWIR OS', 'App installation is available.'); });
    if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }

  /* safe version patching */
  function patchVersions() {
    document.title = 'SWIR OS 1.1 — Neon Core';
    const sub = $('.boot-subtitle'); if (sub) sub.textContent = 'NEON CORE // v1.1';
    $$('#window-layer *').forEach(node => {
      if (node.childNodes.length !== 1 || node.firstChild?.nodeType !== Node.TEXT_NODE) return;
      const old = node.textContent;
      const next = old.replace('SWIR OS Terminal v1.0','SWIR OS Terminal v1.1').replace('SWIR OS v1.0','SWIR OS v1.1').replace('Version 1.0','Version 1.1');
      if (next !== old) node.textContent = next;
    });
  }

  function wireGlobal() {
    document.addEventListener('click', e => { if (e.target.closest('[data-open]')) setTimeout(patchVersions, 40); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && state.panel) closePanels();
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); togglePanel('notifications'); }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'q') { e.preventDefault(); togglePanel('quick'); }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); lock(); }
    });
    let timer;
    window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(layoutIcons, 120); });
    const layer = $('#window-layer');
    if (layer) new MutationObserver(() => setTimeout(patchVersions, 0)).observe(layer, {childList:true, subtree:true});
  }

  function init() {
    if (!window.SwirOS) return setTimeout(init, 40);
    setWallpaper(state.wallpaper);
    patchVersions(); renderNotifications(); updateBadge(); observeCoreToasts();
    wirePanels(); initLock(); syncInstalled(); clickGuard(); wireStore(); wireGlobal(); initPWA();
    updateLockClock(); setInterval(updateLockClock, 1000);
    setTimeout(() => addNotification('SWIR OS 1.1', 'Lock screen, notification center, wallpapers, movable icons and SWIR Store are online.'), 700);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0));
  else setTimeout(init, 0);
})();
