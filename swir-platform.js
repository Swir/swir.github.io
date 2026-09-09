/* =============================================================
   SWIR OS 1.3 — PLATFORM API
   Portable abstraction layer for Web -> Desktop -> System editions.
   ============================================================= */
(() => {
  'use strict';

  const META = Object.freeze({
    name: 'SWIR OS',
    core: 'NEON CORE',
    version: '1.3.0',
    edition: 'WEB',
    build: '2026.09',
    platformApi: 1
  });

  const DB_NAME = 'swir-os-platform';
  const DB_VERSION = 1;
  const FALLBACK_PREFIX = 'swir-platform:';
  const listeners = new Map();
  let dbPromise = null;

  function emit(type, detail = {}) {
    const set = listeners.get(type);
    if (set) set.forEach(fn => { try { fn(detail); } catch (_) {} });
    try { window.dispatchEvent(new CustomEvent(`swir:${type}`, { detail })); } catch (_) {}
  }

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('packages')) db.createObjectStore('packages', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('permissions')) db.createObjectStore('permissions', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
    return dbPromise;
  }

  async function idbGet(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(store, value, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      const req = key === undefined ? os.put(value) : os.put(value, key);
      req.onsuccess = () => resolve(value);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDelete(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbAll(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  const storage = {
    async get(key, fallback = null) {
      try {
        const result = await idbGet('kv', key);
        return result === undefined ? fallback : result;
      } catch (_) {
        try {
          const raw = localStorage.getItem(FALLBACK_PREFIX + key);
          return raw == null ? fallback : JSON.parse(raw);
        } catch (_) { return fallback; }
      }
    },
    async set(key, value) {
      try { await idbPut('kv', value, key); }
      catch (_) { localStorage.setItem(FALLBACK_PREFIX + key, JSON.stringify(value)); }
      emit('storage-change', { key, value });
      return value;
    },
    async remove(key) {
      try { await idbDelete('kv', key); } catch (_) {}
      localStorage.removeItem(FALLBACK_PREFIX + key);
      emit('storage-change', { key, removed: true });
    }
  };

  const files = {
    async list() {
      try { return await idbAll('files'); }
      catch (_) {
        try { return JSON.parse(localStorage.getItem('swir-vfs-v12') || '[]'); }
        catch (_) { return []; }
      }
    },
    async get(id) {
      try { return await idbGet('files', id); }
      catch (_) { return (await files.list()).find(x => x.id === id) || null; }
    },
    async save(file) {
      const item = { ...file, updated: Date.now() };
      if (!item.id) item.id = `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      try { await idbPut('files', item); }
      catch (_) {
        const list = await files.list();
        const i = list.findIndex(x => x.id === item.id);
        if (i >= 0) list[i] = item; else list.push(item);
        localStorage.setItem('swir-vfs-v12', JSON.stringify(list));
      }
      emit('fs-change', { action: 'save', item });
      return item;
    },
    async remove(id) {
      try { await idbDelete('files', id); }
      catch (_) {
        const list = (await files.list()).filter(x => x.id !== id);
        localStorage.setItem('swir-vfs-v12', JSON.stringify(list));
      }
      emit('fs-change', { action: 'remove', id });
    }
  };

  const clipboard = {
    async writeText(text) {
      const value = String(text ?? '');
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
        await storage.set('clipboard.text', value);
        emit('clipboard', { type: 'text', value });
        return true;
      } catch (_) {
        await storage.set('clipboard.text', value);
        return false;
      }
    },
    async readText() {
      try {
        if (navigator.clipboard?.readText) {
          const value = await navigator.clipboard.readText();
          if (value) return value;
        }
      } catch (_) {}
      return storage.get('clipboard.text', '');
    },
    async clear() { await storage.remove('clipboard.text'); emit('clipboard', { clear: true }); }
  };

  const permissions = {
    async list() {
      try { return await idbAll('permissions'); }
      catch (_) { return storage.get('permissions', []); }
    },
    async get(appId, permission) {
      const id = `${appId}:${permission}`;
      try { return await idbGet('permissions', id); }
      catch (_) { return (await permissions.list()).find(x => x.id === id) || null; }
    },
    async set(appId, permission, value) {
      const item = { id: `${appId}:${permission}`, appId, permission, value: value === true, updated: Date.now() };
      try { await idbPut('permissions', item); }
      catch (_) {
        const list = await permissions.list();
        const i = list.findIndex(x => x.id === item.id);
        if (i >= 0) list[i] = item; else list.push(item);
        await storage.set('permissions', list);
      }
      emit('permission-change', item);
      return item;
    }
  };

  const packages = {
    async list() {
      try { return await idbAll('packages'); }
      catch (_) {
        const ids = (() => { try { return JSON.parse(localStorage.getItem('swir-installed-apps') || '[]'); } catch { return []; } })();
        return ids.map(id => ({ id, source: 'legacy-store', installed: true }));
      }
    },
    async install(pkg) {
      const item = { ...pkg, id: pkg.id, installed: true, installedAt: Date.now() };
      try { await idbPut('packages', item); } catch (_) {}
      const legacy = (() => { try { return JSON.parse(localStorage.getItem('swir-installed-apps') || '[]'); } catch { return []; } })();
      if (!legacy.includes(item.id)) localStorage.setItem('swir-installed-apps', JSON.stringify([...legacy, item.id]));
      emit('package-change', { action: 'install', item });
      return item;
    },
    async remove(id) {
      try { await idbDelete('packages', id); } catch (_) {}
      const legacy = (() => { try { return JSON.parse(localStorage.getItem('swir-installed-apps') || '[]'); } catch { return []; } })();
      localStorage.setItem('swir-installed-apps', JSON.stringify(legacy.filter(x => x !== id)));
      emit('package-change', { action: 'remove', id });
    }
  };

  const processes = {
    list() {
      const wins = [...document.querySelectorAll('.os-window')];
      return wins.map((el, index) => {
        const id = el.dataset.window || `window-${index}`;
        const app = window.SwirOS?.apps?.find(x => x.id === id);
        return {
          pid: 1000 + index,
          id,
          title: app?.title || id,
          state: el.classList.contains('minimized') ? 'sleeping' : (el.classList.contains('focused') ? 'active' : 'background'),
          type: app?.type || 'unknown'
        };
      });
    },
    kill(id) {
      if (!window.SwirOS?.close) return false;
      window.SwirOS.close(id);
      emit('process-change', { action: 'kill', id });
      return true;
    },
    open(id) {
      window.SwirOS?.open?.(id);
      emit('process-change', { action: 'open', id });
    }
  };

  const system = {
    info() {
      return {
        ...META,
        online: navigator.onLine,
        language: navigator.language,
        platform: navigator.userAgentData?.platform || navigator.platform || 'Web',
        cores: navigator.hardwareConcurrency || null,
        memoryGB: navigator.deviceMemory || null,
        screen: `${screen.width}x${screen.height}`,
        viewport: `${innerWidth}x${innerHeight}`,
        pwa: matchMedia('(display-mode: standalone)').matches,
        serviceWorker: 'serviceWorker' in navigator
      };
    },
    async storageEstimate() {
      try { return await navigator.storage.estimate(); }
      catch (_) { return { usage: 0, quota: 0 }; }
    },
    async clearRuntimeCaches() {
      if (!('caches' in window)) return 0;
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k.startsWith('swir-os-')).map(k => caches.delete(k)));
      emit('cache-cleared', { count: keys.length });
      return keys.length;
    }
  };

  async function migrateLegacy() {
    const migrated = await storage.get('migration.1.3', false);
    if (migrated) return;
    try {
      const legacyFiles = JSON.parse(localStorage.getItem('swir-vfs-v12') || '[]');
      if (Array.isArray(legacyFiles)) {
        for (const item of legacyFiles) {
          try { await idbPut('files', item); } catch (_) { break; }
        }
      }
    } catch (_) {}
    try {
      const legacyPackages = JSON.parse(localStorage.getItem('swir-installed-apps') || '[]');
      if (Array.isArray(legacyPackages)) {
        for (const id of legacyPackages) {
          try { await idbPut('packages', { id, source: 'legacy-store', installed: true, installedAt: Date.now() }); } catch (_) { break; }
        }
      }
    } catch (_) {}
    await storage.set('migration.1.3', true);
    emit('migration', { version: '1.3' });
  }

  window.SwirPlatform = Object.freeze({
    meta: META,
    storage,
    files,
    clipboard,
    permissions,
    packages,
    processes,
    system,
    events: { on, emit },
    ready: migrateLegacy()
  });

  window.SWIR_PLATFORM = window.SwirPlatform;
  emit('platform-ready', META);
})();
