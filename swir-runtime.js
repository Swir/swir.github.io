/* =============================================================
   SWIR OS 1.7.13 — RUNTIME ADAPTER CONTRACT 1.1.1
   Portable Web -> Desktop -> System host boundary.
   ============================================================= */
(() => {
  'use strict';

  const META = Object.freeze({ name: 'SWIR Runtime', version: '1.1.1', contract: 'swir.runtime/1.0' });
  const SHELL_APP_ID = 'swir.system.shell';
  const host = () => window.SWIR_NATIVE_HOST || null;
  const platform = () => window.SwirPlatform || null;
  const listeners = new Map();

  function emit(type, detail = {}) {
    listeners.get(type)?.forEach(fn => { try { fn(detail); } catch (_) {} });
    try { window.dispatchEvent(new CustomEvent(`swir:runtime:${type}`, { detail })); } catch (_) {}
  }
  function on(type, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn); return () => listeners.get(type)?.delete(fn);
  }
  function nativeMethod(surface, method) {
    const h = host(); const fn = h?.[surface]?.[method];
    return typeof fn === 'function' ? fn.bind(h[surface]) : null;
  }
  async function call(surface, method, args, fallback) {
    const fn = nativeMethod(surface, method);
    if (fn) return fn(...args);
    if (typeof fallback === 'function') return fallback(...args);
    throw Object.assign(new Error(`${surface}.${method} is not available in this runtime`), { code: 'RUNTIME_UNSUPPORTED', surface, method });
  }
  function appIdOf(context) {
    if (context?.appId === undefined || context?.appId === null || context?.appId === '') return SHELL_APP_ID;
    const value = String(context.appId).trim();
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value))
      throw Object.assign(new Error('Invalid SWIR application identity'), { code: 'INVALID_APP_ID' });
    return value;
  }

  async function pickFile(options = {}, context = {}) {
    const owner = appIdOf(context);
    return call('filesystem', 'pickFile', [owner], async () => {
      if (!window.showOpenFilePicker) throw Object.assign(new Error('Native file picker unavailable'), { code: 'RUNTIME_UNSUPPORTED' });
      const [handle] = await window.showOpenFilePicker(options); return handle || null;
    });
  }
  async function pickDirectory(options = {}, context = {}) {
    const owner = appIdOf(context);
    return call('filesystem', 'pickDirectory', [owner], async () => {
      if (!window.showDirectoryPicker) throw Object.assign(new Error('Native directory picker unavailable'), { code: 'RUNTIME_UNSUPPORTED' });
      return window.showDirectoryPicker(options);
    });
  }

  const filesystem = Object.freeze({
    list: (...args) => call('filesystem', 'list', args, (...a) => platform()?.files?.list?.(...a) ?? []),
    get: (...args) => call('filesystem', 'get', args, (...a) => platform()?.files?.get?.(...a) ?? null),
    save: (...args) => call('filesystem', 'save', args, (...a) => platform()?.files?.save?.(...a)),
    remove: (...args) => call('filesystem', 'remove', args, (...a) => platform()?.files?.remove?.(...a)),
    pickFile,
    pickDirectory,
    capabilityInfo: (token, context = {}) => call('filesystem', 'capabilityInfo', [token, appIdOf(context)]),
    readCapabilityText: (token, context = {}) => call('filesystem', 'readCapabilityText', [token, appIdOf(context)]),
    revokeCapability: (token, context = {}) => call('filesystem', 'revokeCapability', [token, appIdOf(context)]),
    revokeOwnerCapabilities: (context = {}) => call('filesystem', 'revokeOwnerCapabilities', [appIdOf(context)]),
    pruneCapabilities: () => call('filesystem', 'pruneCapabilities', []),
    capabilityStatus: () => call('filesystem', 'capabilityStatus', []),
    forApp(appId) {
      const context = Object.freeze({ appId: appIdOf({ appId }) });
      return Object.freeze({
        pickFile: options => pickFile(options, context),
        pickDirectory: options => pickDirectory(options, context),
        capabilityInfo: token => filesystem.capabilityInfo(token, context),
        readCapabilityText: token => filesystem.readCapabilityText(token, context),
        revokeCapability: token => filesystem.revokeCapability(token, context),
        revokeAllCapabilities: () => filesystem.revokeOwnerCapabilities(context)
      });
    }
  });

  const processes = Object.freeze({
    list: (...args) => call('processes', 'list', args, (...a) => platform()?.processes?.list?.(...a) ?? []),
    open: (...args) => call('processes', 'open', args, (...a) => platform()?.processes?.open?.(...a)),
    kill: (...args) => call('processes', 'kill', args, (...a) => platform()?.processes?.kill?.(...a) ?? false),
    spawn: (...args) => call('processes', 'spawn', args)
  });
  const clipboard = Object.freeze({
    readText: (...args) => call('clipboard', 'readText', args, (...a) => platform()?.clipboard?.readText?.(...a) ?? ''),
    writeText: (...args) => call('clipboard', 'writeText', args, (...a) => platform()?.clipboard?.writeText?.(...a) ?? false),
    clear: (...args) => call('clipboard', 'clear', args, (...a) => platform()?.clipboard?.clear?.(...a))
  });
  const tray = Object.freeze({
    set: (...args) => call('tray', 'set', args, async options => ({ ok: false, emulated: true, reason: 'WEB_RUNTIME', options })),
    clear: (...args) => call('tray', 'clear', args, async () => ({ ok: false, emulated: true, reason: 'WEB_RUNTIME' }))
  });
  const network = Object.freeze({
    async status() { return call('network', 'status', [], async () => ({ online: navigator.onLine, type: navigator.connection?.type || navigator.connection?.effectiveType || 'unknown', downlinkMbps: navigator.connection?.downlink ?? null, rttMs: navigator.connection?.rtt ?? null, saveData: navigator.connection?.saveData ?? false })); },
    adapters: (...args) => call('network', 'adapters', args, async () => []),
    scan: (...args) => call('network', 'scan', args), connect: (...args) => call('network', 'connect', args), disconnect: (...args) => call('network', 'disconnect', args)
  });
  const updater = Object.freeze({
    async check() { return call('updater', 'check', [], async () => ({ runtime: 'web', serviceWorker: 'serviceWorker' in navigator, controller: !!navigator.serviceWorker?.controller, updateAvailable: false })); },
    apply: (...args) => call('updater', 'apply', args), restart: (...args) => call('updater', 'restart', args, async () => { location.reload(); return true; })
  });

  function capabilities() {
    const native = !!host(); const surfaces = ['filesystem','processes','clipboard','tray','network','updater']; const result = {};
    for (const surface of surfaces) {
      const impl = host()?.[surface];
      result[surface] = { provider: impl ? 'native' : 'web', native: !!impl, methods: impl ? Object.keys(impl).filter(k => typeof impl[k] === 'function') : Object.keys(api[surface] || {}).filter(k => typeof api[surface][k] === 'function') };
    }
    return { native, edition: native ? String(host()?.edition || 'DESKTOP').toUpperCase() : 'WEB', surfaces: result };
  }
  function info() {
    const caps = capabilities();
    return { ...META, provider: caps.native ? 'native-host' : 'web-adapter', edition: caps.edition, nativeHost: caps.native, nativeSessionId: host()?.sessionId || null, capabilities: caps.surfaces };
  }

  const api = Object.freeze({ meta: META, filesystem, processes, clipboard, tray, network, updater, capabilities, info, events: Object.freeze({ on, emit }), hasNativeHost: () => !!host() });
  window.SwirRuntime = api; window.SWIR_RUNTIME = api; emit('ready', info());
})();
