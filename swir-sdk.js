/* SWIR App SDK 1.0 — Web Edition bridge */
(() => {
  'use strict';
  const catalog = () => Array.isArray(window.SWIR_PACKAGE_CATALOG) ? window.SWIR_PACKAGE_CATALOG : [];
  const platform = () => window.SwirPlatform;

  function manifest(id) { return catalog().find(x => x.id === id || x.packageId === id) || null; }
  function installedSync(id) {
    try { const list = JSON.parse(localStorage.getItem('swir-installed-apps') || '[]'); return Array.isArray(list) && list.includes(id); }
    catch { return false; }
  }
  async function installed(id) {
    const p = platform();
    if (p?.packages?.list) return (await p.packages.list()).some(x => x.id === id && x.installed !== false);
    return installedSync(id);
  }
  async function hasPermission(appId, permission) {
    const record = await platform()?.permissions?.get?.(appId, permission);
    return record?.value === true;
  }
  function namespace(appId) {
    const prefix = `app.${appId}.`;
    return Object.freeze({
      async get(key, fallback = null) { return platform()?.storage?.get?.(prefix + key, fallback) ?? fallback; },
      async set(key, value) { return platform()?.storage?.set?.(prefix + key, value); },
      async remove(key) { return platform()?.storage?.remove?.(prefix + key); }
    });
  }
  async function activeIdentity() {
    const user = await platform()?.identity?.active?.();
    if (!user) return null;
    return { id: user.id, name: user.name, role: user.role, avatar: user.avatar, accent: user.accent };
  }
  function notify(title, message) { window.SwirOS?.toast?.(String(title || 'SWIR App'), String(message || '')); }
  function open(appId) { window.SwirOS?.open?.(appId); }
  function systemInfo() { return platform()?.system?.info?.() || {}; }

  window.SwirAppSDK = Object.freeze({
    meta: Object.freeze({ name: 'SWIR App SDK', version: '1.0.0', schema: 'swir.app/1.0', os: 'SWIR OS 1.6', edition: 'WEB' }),
    catalog,
    manifest,
    installed,
    installedSync,
    permissions: Object.freeze({ has: hasPermission }),
    storage: Object.freeze({ namespace }),
    identity: Object.freeze({ active: activeIdentity }),
    system: Object.freeze({ info: systemInfo }),
    shell: Object.freeze({ open, notify })
  });
})();
