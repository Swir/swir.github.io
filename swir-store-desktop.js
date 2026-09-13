/* SWIR Store Desktop Coordinator 1.0 — Store -> Runtime -> native Package Bridge */
(() => {
  'use strict';

  const META = Object.freeze({ name:'SWIR Store Desktop Coordinator', version:'1.0.0', schema:'swir.store-desktop/1.0' });
  const SHELL_APP_ID = 'swir.system.shell';
  const SIGNED_RELEASE_SCHEMA = 'swir.signed-catalog-release/1.0';

  const root = () => { try { return window.parent && window.parent !== window ? window.parent : window; } catch { return window; } };
  const runtime = () => root().SwirRuntime || window.SwirRuntime || null;

  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function packageId(pkg) { return String(pkg?.packageId || '').trim(); }
  function version(pkg) { return String(pkg?.version || '').trim(); }
  function artifactSha(pkg) {
    const value = pkg?.artifacts?.desktop?.sha256 || pkg?.packageSha256 || '';
    return /^[a-f0-9]{64}$/i.test(String(value)) ? String(value).toLowerCase() : null;
  }
  function signedRelease() {
    const host = root();
    const candidates = [host.SWIR_SIGNED_CATALOG_RELEASE, host.SWIR_SIGNED_CATALOG];
    for (const value of candidates) {
      if (!value || typeof value !== 'object') continue;
      const catalog = Array.isArray(value.catalog) ? value.catalog : null;
      const envelope = value.envelope && typeof value.envelope === 'object' && !Array.isArray(value.envelope) ? value.envelope : null;
      if (catalog && envelope) return { schema:value.schema || SIGNED_RELEASE_SCHEMA, catalog:clone(catalog), envelope:clone(envelope) };
    }
    const catalog = Array.isArray(host.SWIR_SIGNED_PACKAGE_CATALOG) ? host.SWIR_SIGNED_PACKAGE_CATALOG : null;
    const envelope = host.SWIR_SIGNED_CATALOG_ENVELOPE;
    if (catalog && envelope && typeof envelope === 'object' && !Array.isArray(envelope)) return { schema:SIGNED_RELEASE_SCHEMA, catalog:clone(catalog), envelope:clone(envelope) };
    return null;
  }

  async function info() {
    const rt = runtime();
    if (!rt?.packages?.info) return Object.freeze({ ...META, native:false, available:false, mode:'WEB_ONLY', reason:'RUNTIME_PACKAGES_UNAVAILABLE' });
    let bridge;
    try { bridge = await rt.packages.info(); }
    catch (error) { return Object.freeze({ ...META, native:false, available:false, mode:'WEB_ONLY', reason:error?.code || 'PACKAGE_INFO_FAILED' }); }
    const native = bridge?.provider === 'desktop-native' || bridge?.native === true || rt.info?.().nativeHost === true;
    const release = signedRelease();
    const mode = bridge?.trustMode || (bridge?.signedCatalogAuthorization ? 'SIGNED_CATALOG_REQUIRED' : (bridge?.legacySha256Fallback ? 'LEGACY_SHA_UNTIL_ROOT_PROVISIONED' : 'UNAVAILABLE'));
    return Object.freeze({ ...META, native, available:native && mode !== 'UNAVAILABLE', mode, signedReleaseAvailable:!!release, signedCatalogAuthorization:!!bridge?.signedCatalogAuthorization, legacySha256Fallback:!!bridge?.legacySha256Fallback, bridge:clone(bridge) });
  }

  async function plan(pkg) {
    const id = packageId(pkg), ver = version(pkg);
    if (!id || !ver) throw Object.assign(new Error('Desktop Store install requires packageId and version'), { code:'PACKAGE_IDENTITY_INVALID' });
    const state = await info();
    if (!state.native || !state.available) return Object.freeze({ ok:false, mode:'WEB_ONLY', reason:state.reason || 'NATIVE_PACKAGE_BRIDGE_UNAVAILABLE', state });
    const release = signedRelease();
    if (state.mode === 'SIGNED_CATALOG_REQUIRED') {
      if (!release) return Object.freeze({ ok:false, mode:state.mode, reason:'SIGNED_CATALOG_RELEASE_UNAVAILABLE', state });
      const match = release.catalog.find(item => String(item?.packageId || '') === id && String(item?.version || '') === ver);
      if (!match) return Object.freeze({ ok:false, mode:state.mode, reason:'SIGNED_CATALOG_PACKAGE_MISSING', state });
      return Object.freeze({ ok:true, mode:'SIGNED_CATALOG', state, release, packageId:id, version:ver });
    }
    if (state.legacySha256Fallback) {
      const sha256 = artifactSha(pkg);
      if (!sha256) return Object.freeze({ ok:false, mode:state.mode, reason:'DESKTOP_ARTIFACT_SHA256_MISSING', state });
      return Object.freeze({ ok:true, mode:'LEGACY_SHA_PREVIEW', state, sha256, packageId:id, version:ver });
    }
    return Object.freeze({ ok:false, mode:state.mode, reason:'DESKTOP_TRUST_MODE_UNSUPPORTED', state });
  }

  async function pickBundle() {
    const rt = runtime();
    if (!rt?.filesystem?.pickFile) throw Object.assign(new Error('Desktop file capability picker unavailable'), { code:'RUNTIME_UNSUPPORTED' });
    const descriptor = await rt.filesystem.pickFile({ types:[{ description:'SWIR App Package', accept:{ 'application/zip':['.swirapp'] } }], multiple:false }, { appId:SHELL_APP_ID });
    if (!descriptor) throw Object.assign(new Error('Package selection cancelled'), { code:'PACKAGE_SELECTION_CANCELLED' });
    if (!descriptor.token) throw Object.assign(new Error('Native picker did not return a capability token'), { code:'CAPABILITY_INVALID' });
    if (descriptor.kind && descriptor.kind !== 'file') throw Object.assign(new Error('Selected capability is not a file'), { code:'CAPABILITY_KIND_MISMATCH' });
    if (descriptor.name && !String(descriptor.name).toLowerCase().endsWith('.swirapp')) {
      try { await rt.filesystem.revokeCapability?.(descriptor.token, { appId:SHELL_APP_ID }); } catch (_) {}
      throw Object.assign(new Error('Select a .swirapp package'), { code:'PACKAGE_EXTENSION_INVALID' });
    }
    return descriptor;
  }

  async function installNative(pkg, options = {}) {
    const rt = runtime();
    if (!rt?.packages?.installFromCapability) throw Object.assign(new Error('Native package install surface unavailable'), { code:'RUNTIME_UNSUPPORTED' });
    const installPlan = options.plan || await plan(pkg);
    if (!installPlan.ok) throw Object.assign(new Error(`Desktop install blocked: ${installPlan.reason}`), { code:installPlan.reason, plan:installPlan });
    const capability = options.capability || await pickBundle();
    try {
      if (installPlan.mode === 'SIGNED_CATALOG') {
        if (!rt.packages.installAuthorizedFromCapability) throw Object.assign(new Error('Signed catalog Runtime transport unavailable'), { code:'RUNTIME_UNSUPPORTED' });
        return await rt.packages.installAuthorizedFromCapability(capability.token, installPlan.packageId, installPlan.version, installPlan.release.catalog, installPlan.release.envelope);
      }
      return await rt.packages.installFromCapability(capability.token, installPlan.sha256);
    } catch (error) {
      try { await rt.filesystem.revokeCapability?.(capability.token, { appId:SHELL_APP_ID }); } catch (_) {}
      throw error;
    }
  }

  async function installTransactional(pkg, options = {}) {
    if (typeof options.webCommit !== 'function' || typeof options.webRollback !== 'function') throw new Error('webCommit and webRollback callbacks are required');
    const installPlan = await plan(pkg);
    if (!installPlan.ok) throw Object.assign(new Error(`Desktop install blocked: ${installPlan.reason}`), { code:installPlan.reason, plan:installPlan });
    const capability = await pickBundle();
    let webResult = null;
    try {
      webResult = await options.webCommit();
      if (!webResult?.transaction?.id) throw Object.assign(new Error('Web package transaction did not return a committed transaction id'), { code:'WEB_TRANSACTION_MISSING' });
      const nativeResult = await installNative(pkg, { plan:installPlan, capability });
      return Object.freeze({ ok:true, schema:META.schema, mode:installPlan.mode, packageId:installPlan.packageId, version:installPlan.version, web:webResult, native:nativeResult });
    } catch (error) {
      if (webResult?.transaction?.id) {
        try { await options.webRollback(webResult.transaction.id, `NATIVE_DESKTOP_INSTALL_FAILED: ${String(error?.code || error?.message || error)}`); }
        catch (rollbackError) {
          error.webRollbackError = String(rollbackError?.message || rollbackError);
        }
      } else {
        try { await runtime()?.filesystem?.revokeCapability?.(capability.token, { appId:SHELL_APP_ID }); } catch (_) {}
      }
      throw error;
    }
  }

  async function status(packageIdValue) {
    const rt = runtime();
    if (!rt?.packages?.status) throw Object.assign(new Error('Native package status unavailable'), { code:'RUNTIME_UNSUPPORTED' });
    return rt.packages.status(packageIdValue);
  }

  async function rollback(packageIdValue) {
    const rt = runtime();
    if (!rt?.packages?.rollback) throw Object.assign(new Error('Native package rollback unavailable'), { code:'RUNTIME_UNSUPPORTED' });
    return rt.packages.rollback(packageIdValue);
  }

  window.SwirStoreDesktop = Object.freeze({ meta:META, info, plan, pickBundle, installNative, installTransactional, status, rollback });
})();
