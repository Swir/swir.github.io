/* SWIR App SDK 1.1 — Web Edition bridge */
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
      path: `SWIR://APPDATA/${String(appId||'APP').toUpperCase()}`,
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
  function systemInfo() { const info=platform()?.system?.info?.()||{}; return {...info,version:'1.7.0'}; }
  function associationService(){return window.SwirAssociations||null}
  async function openFile(file,appId=null){const svc=associationService();if(!svc)throw new Error('File association service unavailable');return svc.openFile(file,appId)}
  async function consumeOpen(appId){const svc=associationService();return svc?svc.consume(appId):null}
  function handlersFor(name){return associationService()?.handlersFor?.(name)||[]}
  function defaultFor(name){return associationService()?.defaultFor?.(name)||null}
  function setDefault(extension,appId){return associationService()?.setDefault?.(extension,appId)}
  function extension(name){return associationService()?.extension?.(name)||''}
  function appData(appId){return namespace(appId)}

  window.SwirAppSDK = Object.freeze({
    meta: Object.freeze({ name: 'SWIR App SDK', version: '1.1.0', schema: 'swir.app/1.0', os: 'SWIR OS 1.7', edition: 'WEB' }),
    catalog,
    manifest,
    installed,
    installedSync,
    permissions: Object.freeze({ has: hasPermission }),
    storage: Object.freeze({ namespace }),
    identity: Object.freeze({ active: activeIdentity }),
    files: Object.freeze({ open:openFile, consumeOpen, handlersFor, defaultFor, setDefault, extension, appData }),
    system: Object.freeze({ info: systemInfo }),
    shell: Object.freeze({ open, notify })
  });
})();
