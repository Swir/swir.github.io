/* SWIR OS App Bridge 0.5 — package-side portable API */
(() => {
  'use strict';
  if (window.SwirAppBridge) return;
  const script = document.currentScript;
  const packageId = String(script?.dataset?.swirPackage || '').trim();
  const appId = String(script?.dataset?.swirApp || '').trim();
  const REQUEST = 'SWIR_APP_BRIDGE_REQUEST';
  const RESULT = 'SWIR_APP_BRIDGE_RESULT';
  const OPEN_FILE = 'SWIR_APP_BRIDGE_OPEN_FILE';
  const pending = new Map();
  let seq = 0;

  function targetOrigin() {
    if (location.hostname.endsWith('.swir.local')) return 'https://swir.local';
    return location.origin;
  }
  function call(method, ...args) {
    if (!packageId) return Promise.reject(Object.assign(new Error('Missing data-swir-package'), { code: 'INVALID_APP_ID' }));
    const id = `app-${Date.now()}-${++seq}`;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('SWIR App Bridge timeout'), { code: 'BRIDGE_TIMEOUT' })); }, 8000);
      pending.set(id, { resolve, reject, timer });
    });
    parent.postMessage({ type: REQUEST, id, packageId, method, args }, targetOrigin());
    return promise;
  }

  addEventListener('message', event => {
    if (event.source !== parent || event.origin !== targetOrigin()) return;
    const msg = event.data;
    if (msg?.type === RESULT && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error?.message || 'SWIR App Bridge error'), { code: msg.error?.code || 'APP_BRIDGE_ERROR' }));
      return;
    }
    if (msg?.type === OPEN_FILE && msg.packageId === packageId && msg.appId === appId) {
      dispatchEvent(new CustomEvent('swir:open-file', { detail: msg.file }));
    }
  });

  const storage = Object.freeze({
    get: (key, fallback = null) => call('storage.get', key, fallback),
    set: (key, value) => call('storage.set', key, value),
    remove: key => call('storage.remove', key)
  });
  const files = Object.freeze({ consumeOpen: () => call('files.consumeOpen') });
  const sdk = Object.freeze({
    files,
    identity: Object.freeze({ active: () => call('identity.active') }),
    notifications: Object.freeze({ send: options => call('notifications.send', options) }),
    shell: Object.freeze({ notify: (title, message) => call('shell.notify', title, message) }),
    bridge: Object.freeze({ info: () => call('bridge.info') })
  });
  const platform = Object.freeze({ storage });
  window.SwirAppBridge = Object.freeze({ version: '0.5.0-preview', packageId, appId, call, storage, files, sdk, platform });
  dispatchEvent(new CustomEvent('swir:app-bridge-ready', { detail: { packageId, appId } }));
})();
