/* SWIR OS native module bridge */
(() => {
  'use strict';

  const LEGACY_IDS = ['winamp','time','time2','tomi','test','testy','retro','atari','c64','mac','swiramp'];
  const RAW_BASE = 'https://raw.githubusercontent.com/Swir/swir.github.io/main/';

  function cleanLegacyShortcuts() {
    try {
      const list = JSON.parse(localStorage.getItem('swir-installed-apps') || '[]');
      if (Array.isArray(list)) {
        const next = list.filter(id => !LEGACY_IDS.includes(id));
        localStorage.setItem('swir-installed-apps', JSON.stringify(next));
      }
    } catch (_) {}
  }

  async function cleanLegacyPackages() {
    try {
      if (!window.SwirPlatform) return;
      await window.SwirPlatform.ready;
      for (const id of LEGACY_IDS) await window.SwirPlatform.packages.remove(id);
    } catch (_) {}
  }

  function openApp(id) {
    const exists = window.SwirOS?.apps?.some(app => app.id === id);
    if (exists) window.SwirOS.open(id);
  }

  async function downloadStatic(path, name) {
    try {
      const response = await fetch(path, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const type = name.endsWith('.php') ? 'application/x-httpd-php;charset=utf-8' : 'text/plain;charset=utf-8';
      const blob = new Blob([text], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1200);
      window.SwirOS?.toast?.('System Files', `${name} downloaded.`);
    } catch (error) {
      window.SwirOS?.toast?.('System Files', `Download failed: ${error.message}`);
    }
  }

  function enhanceChat(frame) {
    const doc = frame.contentDocument;
    if (!doc) return;

    const actions = doc.querySelector('#setup .actions');
    if (actions && !doc.querySelector('#download-chat-server')) {
      const button = doc.createElement('button');
      button.id = 'download-chat-server';
      button.type = 'button';
      button.className = 'btn primary';
      button.textContent = 'DOWNLOAD CHAT SERVER API';
      button.addEventListener('click', () => openApp('chatkit'));
      actions.prepend(button);
    }

    const top = doc.querySelector('#chat .top');
    if (top && !doc.querySelector('#chat-server-kit-button')) {
      const button = doc.createElement('button');
      button.id = 'chat-server-kit-button';
      button.type = 'button';
      button.className = 'iconbtn';
      button.textContent = 'SERVER KIT';
      button.title = 'Download SWIR Chat backend';
      button.addEventListener('click', () => openApp('chatkit'));
      const configure = doc.querySelector('#configure');
      top.insertBefore(button, configure || null);
    }
  }

  function systemCard(doc, icon, title, desc) {
    const card = doc.createElement('article');
    card.className = 'item';
    card.innerHTML = `<div class="ico">${icon}</div><strong>${title}</strong><span>${desc}</span>`;
    return card;
  }

  function enhanceFiles(frame) {
    const doc = frame.contentDocument;
    if (!doc || doc.querySelector('#system-files-nav')) return;
    const side = doc.querySelector('.side');
    const grid = doc.querySelector('#grid');
    const title = doc.querySelector('#title');
    const sub = doc.querySelector('#sub');
    const path = doc.querySelector('#path');
    if (!side || !grid || !title || !sub || !path) return;

    const nav = doc.createElement('button');
    nav.id = 'system-files-nav';
    nav.type = 'button';
    nav.innerHTML = '⚙ System Files';
    side.appendChild(nav);

    doc.querySelectorAll('[data-view]').forEach(button => {
      button.addEventListener('click', () => nav.classList.remove('active'));
    });

    nav.addEventListener('click', () => {
      doc.querySelectorAll('.side button').forEach(button => button.classList.remove('active'));
      nav.classList.add('active');
      path.textContent = 'SWIR://SYSTEM';
      title.textContent = 'System Files';
      sub.textContent = 'Installers, server components and SWIR OS documentation.';
      const empty = doc.querySelector('#empty');
      const newFolder = doc.querySelector('#newFolder');
      const newText = doc.querySelector('#newText');
      if (empty) empty.style.display = 'none';
      if (newFolder) newFolder.style.display = 'none';
      if (newText) newText.style.display = 'none';
      grid.innerHTML = '';

      const kit = systemCard(doc, 'API', 'Chat Server Kit', 'Installer package and guided setup for your own SWIR Chat server.');
      kit.addEventListener('click', () => openApp('chatkit'));
      grid.appendChild(kit);

      const api = systemCard(doc, 'PHP', 'swir-chat-api.php', 'Self-installing PHP + MySQL/MariaDB backend for SWIR Chat.');
      api.addEventListener('click', () => downloadStatic(RAW_BASE + 'swir-chat-api.php', 'swir-chat-api.php'));
      grid.appendChild(api);

      const guide = systemCard(doc, 'MD', 'SWIR-CHAT-SERVER.md', 'Chat server installation and configuration guide.');
      guide.addEventListener('click', () => downloadStatic(RAW_BASE + 'SWIR-CHAT-SERVER.md', 'SWIR-CHAT-SERVER.md'));
      grid.appendChild(guide);

      const arch = systemCard(doc, 'SYS', 'SWIR-OS-ARCHITECTURE.md', 'Web → Desktop → System architecture roadmap.');
      arch.addEventListener('click', () => downloadStatic(RAW_BASE + 'SWIR-OS-ARCHITECTURE.md', 'SWIR-OS-ARCHITECTURE.md'));
      grid.appendChild(arch);
    });
  }

  function enhanceFrame(frame) {
    try {
      const pathname = new URL(frame.src, location.href).pathname.toLowerCase();
      if (pathname.endsWith('/swir-chat.html')) enhanceChat(frame);
      if (pathname.endsWith('/swir-files.html')) enhanceFiles(frame);
    } catch (_) {}
  }

  function watchFrames() {
    const layer = document.querySelector('#window-layer');
    if (!layer) return;
    const attach = frame => {
      if (!(frame instanceof HTMLIFrameElement) || frame.dataset.swirNativeHook === '1') return;
      frame.dataset.swirNativeHook = '1';
      frame.addEventListener('load', () => enhanceFrame(frame));
      setTimeout(() => enhanceFrame(frame), 60);
    };
    layer.querySelectorAll('iframe').forEach(attach);
    new MutationObserver(records => {
      records.forEach(record => record.addedNodes.forEach(node => {
        if (node instanceof HTMLIFrameElement) attach(node);
        if (node instanceof Element) node.querySelectorAll?.('iframe').forEach(attach);
      }));
    }).observe(layer, { childList: true, subtree: true });
  }

  function wireTerminal() {
    document.addEventListener('keydown', event => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.id !== 'terminal-input' || event.key !== 'Enter') return;
      const command = input.value.trim().toLowerCase();
      if (!['chatserver','chatapi','serverkit'].includes(command)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const output = document.querySelector('#terminal-output');
      if (output) {
        const prompt = document.createElement('div');
        prompt.className = 'term-ok';
        prompt.textContent = `swir@neon-core:~$ ${command}`;
        const result = document.createElement('div');
        result.className = 'term-accent';
        result.textContent = 'Opening SWIR Chat Server Kit...';
        output.append(prompt, result);
        output.scrollTop = output.scrollHeight;
      }
      input.value = '';
      openApp('chatkit');
    }, true);
  }

  window.addEventListener('message', event => {
    if (event.origin !== location.origin || !event.data) return;
    if (event.data.type === 'SWIR_NATIVE_OPEN') openApp(String(event.data.id || ''));
  });

  cleanLegacyShortcuts();
  cleanLegacyPackages();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { watchFrames(); wireTerminal(); });
  } else {
    watchFrames();
    wireTerminal();
  }
})();
