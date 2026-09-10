/* SWIR OS 1.7.13 — portable App Bridge host broker */
(() => {
  'use strict';
  if (window.top !== window || window.SwirAppBridgeHost) return;

  const VERSION = '0.5.2-preview';
  const REQUEST = 'SWIR_APP_BRIDGE_REQUEST';
  const RESULT = 'SWIR_APP_BRIDGE_RESULT';
  const OPEN_FILE = 'SWIR_APP_BRIDGE_OPEN_FILE';
  const ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
  const MAX_NETWORK_BODY = 64 * 1024;
  const MAX_NETWORK_RESPONSE = 1024 * 1024;
  const ALLOWED_METHODS = new Set(['GET', 'POST']);
  const ALLOWED_HEADERS = new Set(['accept', 'content-type', 'x-swir-key']);

  const catalog = () => Array.isArray(window.SWIR_PACKAGE_CATALOG) ? window.SWIR_PACKAGE_CATALOG : [];
  const byPackage = id => catalog().find(p => p.packageId === id) || null;
  const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '-');
  const normalizedEntry = p => String(p?.entry || '').replace(/^\.\//, '');
  const expectedDesktopOrigin = p => `https://app-${slug(p.packageId)}.swir.local`;

  function frameForSource(source) {
    for (const frame of document.querySelectorAll('iframe')) {
      try { if (frame.contentWindow === source) return frame; } catch (_) {}
    }
    return null;
  }

  function resolveCaller(event, claimedPackageId) {
    if (!ID_RE.test(String(claimedPackageId || ''))) throw bridgeError('INVALID_APP_ID', 'Valid packageId is required.');
    const pkg = byPackage(String(claimedPackageId));
    if (!pkg) throw bridgeError('UNKNOWN_PACKAGE', 'Package is not in the trusted catalog.');
    const frame = frameForSource(event.source);
    if (!frame) throw bridgeError('UNTRUSTED_SOURCE', 'Bridge request is not associated with a managed SWIR iframe.');

    let src;
    try { src = new URL(frame.src, location.href); } catch { throw bridgeError('UNTRUSTED_SOURCE', 'Invalid application frame URL.'); }
    const entry = normalizedEntry(pkg);
    const webOk = event.origin === location.origin && src.origin === location.origin && src.pathname.endsWith('/' + entry);
    const desktopOrigin = expectedDesktopOrigin(pkg);
    const desktopOk = event.origin === desktopOrigin && src.origin === desktopOrigin && src.pathname === '/' + entry;
    if (!webOk && !desktopOk) throw bridgeError('IDENTITY_MISMATCH', 'Frame origin/entry does not match package policy.');
    return pkg;
  }

  function bridgeError(code, message) { const e = new Error(message); e.code = code; return e; }
  async function hasPermission(pkg, permission) {
    if (!(pkg.permissions || []).includes(permission)) return false;
    try { return (await window.SwirPlatform?.permissions?.get?.(pkg.id, permission))?.value === true; }
    catch { return false; }
  }
  async function requirePermission(pkg, permission) {
    if (!(await hasPermission(pkg, permission))) throw bridgeError('PERMISSION_DENIED', `${pkg.packageId} lacks ${permission}.`);
  }
  async function requireAnyPermission(pkg, permissions) {
    for (const permission of permissions) if (await hasPermission(pkg, permission)) return permission;
    throw bridgeError('PERMISSION_DENIED', `${pkg.packageId} lacks required permission (${permissions.join(' or ')}).`);
  }

  function webStorage(pkg) {
    return window.SwirAppSDK?.storage?.namespace?.(pkg.id) || null;
  }

  function nativeAppData() {
    if (window.SWIR_NATIVE_HOST?.features?.nativeAppData !== true) return null;
    const api = window.SwirRuntime?.appData;
    return api && typeof api.get === 'function' && typeof api.set === 'function' && typeof api.remove === 'function' ? api : null;
  }

  function missingMarker() {
    const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    return { __swirNativeAppDataMissing: nonce };
  }

  function markerMatches(value, marker) {
    return !!value && typeof value === 'object' && value.__swirNativeAppDataMissing === marker.__swirNativeAppDataMissing;
  }

  async function storageGet(pkg, key, fallback = null) {
    const normalizedKey = String(key || '');
    const native = nativeAppData();
    const web = webStorage(pkg);
    if (!native) return web?.get?.(normalizedKey, fallback) ?? fallback;

    const nativeMissing = missingMarker();
    const nativeValue = await native.get(pkg.packageId, normalizedKey, nativeMissing);
    if (!markerMatches(nativeValue, nativeMissing)) return nativeValue;

    if (!web?.get) return fallback;
    const webMissing = missingMarker();
    const legacyValue = await web.get(normalizedKey, webMissing);
    if (markerMatches(legacyValue, webMissing)) return fallback;

    await native.set(pkg.packageId, normalizedKey, legacyValue);
    return legacyValue;
  }

  async function storageSet(pkg, key, value) {
    const normalizedKey = String(key || '');
    const native = nativeAppData();
    if (native) return native.set(pkg.packageId, normalizedKey, value);
    return webStorage(pkg)?.set?.(normalizedKey, value);
  }

  async function storageRemove(pkg, key) {
    const normalizedKey = String(key || '');
    const native = nativeAppData();
    if (native) return native.remove(pkg.packageId, normalizedKey);
    return webStorage(pkg)?.remove?.(normalizedKey);
  }

  function isPrivateHostname(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!h || h === 'localhost' || h === '::1' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
    if (/^(?:0|127)(?:\.|$)/.test(h) || /^169\.254\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
    const m = h.match(/^172\.(\d{1,3})\./);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
    if (/^(?:fc|fd)[0-9a-f]{2}:/i.test(h) || /^fe[89ab][0-9a-f]:/i.test(h)) return true;
    return false;
  }

  function normalizeNetworkRequest(input) {
    const options = input && typeof input === 'object' ? input : {};
    let url;
    try { url = new URL(String(options.url || '')); } catch { throw bridgeError('NETWORK_INVALID_URL', 'A valid HTTPS URL is required.'); }
    if (url.protocol !== 'https:') throw bridgeError('NETWORK_HTTPS_REQUIRED', 'App Bridge network requests require HTTPS.');
    if (url.username || url.password) throw bridgeError('NETWORK_INVALID_URL', 'Credentials in URLs are not allowed.');
    if (isPrivateHostname(url.hostname)) throw bridgeError('NETWORK_PRIVATE_TARGET_BLOCKED', 'Private, loopback and local network targets are blocked.');

    const method = String(options.method || 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) throw bridgeError('NETWORK_METHOD_NOT_ALLOWED', `Network method is not allowed: ${method}`);

    const headers = {};
    const rawHeaders = options.headers && typeof options.headers === 'object' ? options.headers : {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      const lower = String(key).toLowerCase();
      if (!ALLOWED_HEADERS.has(lower)) throw bridgeError('NETWORK_HEADER_NOT_ALLOWED', `Network header is not allowed: ${key}`);
      headers[key] = String(value).slice(0, 4096);
    }

    let body;
    if (options.body !== undefined && options.body !== null) {
      if (method === 'GET') throw bridgeError('NETWORK_BODY_NOT_ALLOWED', 'GET requests cannot include a body.');
      body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      if (new TextEncoder().encode(body).byteLength > MAX_NETWORK_BODY) throw bridgeError('NETWORK_BODY_TOO_LARGE', 'Network request body exceeds 64 KiB.');
    }
    return { url: url.toString(), method, headers, body };
  }

  async function networkRequest(input) {
    const request = normalizeNetworkRequest(input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw bridgeError('NETWORK_TIMEOUT', 'Network request timed out.');
      throw bridgeError('NETWORK_FAILED', error?.message || 'Network request failed.');
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_NETWORK_RESPONSE) throw bridgeError('NETWORK_RESPONSE_TOO_LARGE', 'Network response exceeds 1 MiB.');
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch { throw bridgeError('NETWORK_INVALID_JSON', `Expected JSON response (HTTP ${response.status}).`); }
    }
    return { ok: response.ok && data?.ok !== false, status: response.status, data, error: data?.error || (!response.ok ? `HTTP ${response.status}` : null) };
  }

  async function dispatch(pkg, method, args) {
    switch (method) {
      case 'bridge.info':
        return { version: VERSION, packageId: pkg.packageId, appId: pkg.id, edition: window.SWIR_NATIVE_HOST?.edition || 'WEB', nativeAppData: !!nativeAppData() };
      case 'storage.get':
        await requireAnyPermission(pkg, ['storage', 'files.read']);
        return storageGet(pkg, args?.[0], args?.[1] ?? null);
      case 'storage.set':
        await requireAnyPermission(pkg, ['storage', 'files.write']);
        return storageSet(pkg, args?.[0], args?.[1]);
      case 'storage.remove':
        await requireAnyPermission(pkg, ['storage', 'files.write']);
        return storageRemove(pkg, args?.[0]);
      case 'files.consumeOpen':
        await requirePermission(pkg, 'files.read');
        return window.SwirAppSDK?.files?.consumeOpen?.(pkg.id) ?? null;
      case 'network.request':
        await requirePermission(pkg, 'network');
        return networkRequest(args?.[0]);
      case 'identity.active':
        await requirePermission(pkg, 'identity.basic');
        return window.SwirAppSDK?.identity?.active?.() ?? null;
      case 'notifications.send':
        await requirePermission(pkg, 'notifications');
        return window.SwirAppSDK?.notifications?.send?.(pkg.id, args?.[0] || {});
      case 'shell.notify':
        return window.SwirAppSDK?.shell?.notify?.(String(args?.[0] || pkg.name), String(args?.[1] || ''));
      default:
        throw bridgeError('METHOD_NOT_ALLOWED', `App Bridge method is not allowed: ${method}`);
    }
  }

  addEventListener('message', async event => {
    const msg = event.data;
    if (!msg || msg.type !== REQUEST || typeof msg.id !== 'string') return;
    const targetOrigin = event.origin;
    try {
      const pkg = resolveCaller(event, msg.packageId);
      const result = await dispatch(pkg, String(msg.method || ''), Array.isArray(msg.args) ? msg.args : []);
      event.source?.postMessage({ type: RESULT, id: msg.id, ok: true, result }, targetOrigin);
    } catch (error) {
      event.source?.postMessage({ type: RESULT, id: msg.id, ok: false, error: { code: error?.code || 'APP_BRIDGE_ERROR', message: error?.message || 'App Bridge error' } }, targetOrigin);
    }
  });

  function deliverOpenFile(appId, file) {
    const pkg = catalog().find(p => p.id === appId);
    if (!pkg) return false;
    const frame = document.querySelector(`.os-window[data-window="${CSS.escape(appId)}"] iframe`);
    if (!frame?.contentWindow) return false;
    let origin;
    try { origin = new URL(frame.src, location.href).origin; } catch { return false; }
    const valid = origin === location.origin || origin === expectedDesktopOrigin(pkg);
    if (!valid) return false;
    frame.contentWindow.postMessage({ type: OPEN_FILE, appId, packageId: pkg.packageId, file }, origin);
    return true;
  }

  window.SwirAppBridgeHost = Object.freeze({ version: VERSION, deliverOpenFile });
})();