/* SWIR OS 1.7.13 — portable App Bridge host broker */
(() => {
  'use strict';
  if (window.top !== window || window.SwirAppBridgeHost) return;

  const VERSION = '0.5.0-preview';
  const REQUEST = 'SWIR_APP_BRIDGE_REQUEST';
  const RESULT = 'SWIR_APP_BRIDGE_RESULT';
  const OPEN_FILE = 'SWIR_APP_BRIDGE_OPEN_FILE';
  const ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

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

  async function dispatch(pkg, method, args) {
    switch (method) {
      case 'bridge.info':
        return { version: VERSION, packageId: pkg.packageId, appId: pkg.id, edition: window.SWIR_NATIVE_HOST?.edition || 'WEB' };
      case 'storage.get':
        await requirePermission(pkg, 'storage').catch(async e => { if (pkg.id !== 'code' || !(pkg.permissions || []).includes('files.write')) throw e; });
        return window.SwirAppSDK?.storage?.namespace?.(pkg.id)?.get?.(String(args?.[0] || ''), args?.[1] ?? null);
      case 'storage.set':
        await requirePermission(pkg, 'storage').catch(async e => { if (pkg.id !== 'code' || !(pkg.permissions || []).includes('files.write')) throw e; });
        return window.SwirAppSDK?.storage?.namespace?.(pkg.id)?.set?.(String(args?.[0] || ''), args?.[1]);
      case 'storage.remove':
        await requirePermission(pkg, 'storage').catch(async e => { if (pkg.id !== 'code' || !(pkg.permissions || []).includes('files.write')) throw e; });
        return window.SwirAppSDK?.storage?.namespace?.(pkg.id)?.remove?.(String(args?.[0] || ''));
      case 'files.consumeOpen':
        await requirePermission(pkg, 'files.read');
        return window.SwirAppSDK?.files?.consumeOpen?.(pkg.id) ?? null;
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
    let targetOrigin = event.origin;
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
