/* SWIR Store Desktop Coordinator 1.1 — Store -> Runtime -> native Package Bridge + restart reconciliation */
(() => {
  'use strict';

  const META = Object.freeze({ name:'SWIR Store Desktop Coordinator', version:'1.1.0', schema:'swir.store-desktop/1.0', recoverySchema:'swir.store-desktop-recovery/1.0' });
  const SHELL_APP_ID = 'swir.system.shell';
  const SIGNED_RELEASE_SCHEMA = 'swir.signed-catalog-release/1.0';
  const RECOVERY_KEY = 'store.desktop.pending.v1';
  const RECOVERY_LIMIT = 20;

  const root = () => { try { return window.parent && window.parent !== window ? window.parent : window; } catch { return window; } };
  const runtime = () => root().SwirRuntime || window.SwirRuntime || null;
  const platform = () => root().SwirPlatform || window.SwirPlatform || null;

  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function packageId(pkg) { return String(pkg?.packageId || '').trim(); }
  function version(pkg) { return String(pkg?.version || '').trim(); }
  function webPackageId(pkg) { return String(pkg?.id || pkg?.packageId || '').trim(); }
  function recoveryId() { return `desktop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`; }
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

  async function readRecovery() {
    const storage = platform()?.storage;
    if (!storage?.get) return [];
    const value = await storage.get(RECOVERY_KEY, []);
    return Array.isArray(value) ? value.filter(x => x && x.schema === META.recoverySchema) : [];
  }
  async function writeRecovery(list) {
    const storage = platform()?.storage;
    if (!storage?.set) return [];
    const bounded = (Array.isArray(list) ? list : []).slice(-RECOVERY_LIMIT);
    await storage.set(RECOVERY_KEY, bounded);
    return bounded;
  }
  async function addRecovery(pkg) {
    const list = await readRecovery();
    const record = {
      schema:META.recoverySchema,
      id:recoveryId(),
      packageId:packageId(pkg),
      webPackageId:webPackageId(pkg),
      version:version(pkg),
      webTransactionId:null,
      state:'PREPARED',
      createdAt:Date.now(),
      updatedAt:Date.now()
    };
    list.push(record);
    await writeRecovery(list);
    return clone(record);
  }
  async function patchRecovery(id, patch) {
    const list = await readRecovery();
    const index = list.findIndex(x => x.id === id);
    if (index < 0) return null;
    list[index] = { ...list[index], ...clone(patch || {}), updatedAt:Date.now() };
    await writeRecovery(list);
    return clone(list[index]);
  }
  async function removeRecovery(id) {
    const list = await readRecovery();
    await writeRecovery(list.filter(x => x.id !== id));
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
    return Object.freeze({ ...META, native, available:native && mode !== 'UNAVAILABLE', mode, signedReleaseAvailable:!!release, signedCatalogAuthorization:!!bridge?.signedCatalogAuthorization, legacySha256Fallback:!!bridge?.legacySha256Fallback, restartReconciliation:!!platform()?.storage?.get && !!platform()?.storage?.set, bridge:clone(bridge) });
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
    const recovery = await addRecovery(pkg);
    let webResult = null;
    try {
      webResult = await options.webCommit();
      if (!webResult?.transaction?.id) throw Object.assign(new Error('Web package transaction did not return a committed transaction id'), { code:'WEB_TRANSACTION_MISSING' });
      await patchRecovery(recovery.id, { state:'WEB_COMMITTED', webTransactionId:webResult.transaction.id });
      const nativeResult = await installNative(pkg, { plan:installPlan, capability });
      await removeRecovery(recovery.id);
      return Object.freeze({ ok:true, schema:META.schema, mode:installPlan.mode, packageId:installPlan.packageId, version:installPlan.version, web:webResult, native:nativeResult, recovery:'CLEAN' });
    } catch (error) {
      if (webResult?.transaction?.id) {
        try {
          await options.webRollback(webResult.transaction.id, `NATIVE_DESKTOP_INSTALL_FAILED: ${String(error?.code || error?.message || error)}`);
          await removeRecovery(recovery.id);
        } catch (rollbackError) {
          await patchRecovery(recovery.id, { state:'ROLLBACK_REQUIRED', error:String(rollbackError?.message || rollbackError) });
          error.webRollbackError = String(rollbackError?.message || rollbackError);
        }
      } else {
        try { await runtime()?.filesystem?.revokeCapability?.(capability.token, { appId:SHELL_APP_ID }); } catch (_) {}
        await removeRecovery(recovery.id);
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

  async function reconcile(options = {}) {
    const pipe = options.pipeline || root().SwirInstallPipeline || window.SwirInstallPipeline;
    const state = await info();
    if (!state.native || !state.available) return Object.freeze({ ok:true, state:'SKIPPED', reason:'NATIVE_PACKAGE_BRIDGE_UNAVAILABLE', checked:0, repaired:0, consistent:0, errors:[] });
    if (!pipe?.transactions || !pipe?.rollback) return Object.freeze({ ok:false, state:'BLOCKED', reason:'INSTALL_PIPELINE_RECOVERY_UNAVAILABLE', checked:0, repaired:0, consistent:0, errors:[] });
    const pending = await readRecovery();
    if (!pending.length) return Object.freeze({ ok:true, state:'CLEAN', checked:0, repaired:0, consistent:0, errors:[] });
    const transactions = await pipe.transactions();
    let repaired = 0, consistent = 0;
    const errors = [];
    for (const record of pending) {
      let tx = record.webTransactionId ? transactions.find(x => x?.id === record.webTransactionId) : null;
      if (!tx) {
        tx = transactions.find(x => x?.status === 'COMMITTED' && String(x?.toVersion || '') === record.version && (String(x?.packageId || '') === record.webPackageId || String(x?.packageId || '') === record.packageId) && Number(x?.startedAt || 0) >= Number(record.createdAt || 0) - 5000) || null;
        if (tx?.id) await patchRecovery(record.id, { state:'WEB_COMMITTED', webTransactionId:tx.id });
      }
      let nativeState = null;
      try { nativeState = await status(record.packageId); }
      catch (error) { errors.push({ id:record.id, packageId:record.packageId, code:error?.code || 'NATIVE_STATUS_FAILED', message:String(error?.message || error) }); continue; }
      if (nativeState?.installed === true && String(nativeState?.version || '') === record.version) {
        await removeRecovery(record.id);
        consistent++;
        continue;
      }
      if (tx?.status === 'COMMITTED' && !tx?.rollback?.performed) {
        try {
          await pipe.rollback(tx.id, { approved:true, reason:`DESKTOP_RECONCILE_NATIVE_${nativeState?.installed ? 'VERSION_MISMATCH' : 'MISSING'}` });
          await removeRecovery(record.id);
          repaired++;
        } catch (error) {
          await patchRecovery(record.id, { state:'ROLLBACK_REQUIRED', error:String(error?.message || error) });
          errors.push({ id:record.id, packageId:record.packageId, code:'WEB_ROLLBACK_FAILED', message:String(error?.message || error) });
        }
        continue;
      }
      if (!tx || ['ROLLED_BACK','FAILED'].includes(String(tx.status || ''))) {
        await removeRecovery(record.id);
        repaired++;
        continue;
      }
      errors.push({ id:record.id, packageId:record.packageId, code:'RECOVERY_TRANSACTION_STATE_UNRESOLVED', transactionStatus:String(tx?.status || 'UNKNOWN') });
    }
    return Object.freeze({ ok:errors.length === 0, state:errors.length ? 'ATTENTION' : 'RECONCILED', checked:pending.length, repaired, consistent, errors:clone(errors) });
  }

  window.SwirStoreDesktop = Object.freeze({ meta:META, info, plan, pickBundle, installNative, installTransactional, status, rollback, reconcile });
})();
