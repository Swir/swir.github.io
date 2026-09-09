/* SWIR OS native module bridge */
(() => {
  'use strict';

  const LEGACY_IDS = ['winamp','time','time2','tomi','test','testy'];

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

  window.addEventListener('message', event => {
    if (event.origin !== location.origin || !event.data) return;
    if (event.data.type === 'SWIR_NATIVE_OPEN') {
      const id = String(event.data.id || '');
      const exists = window.SwirOS?.apps?.some(app => app.id === id);
      if (exists) window.SwirOS.open(id);
    }
  });

  cleanLegacyShortcuts();
  cleanLegacyPackages();
})();
