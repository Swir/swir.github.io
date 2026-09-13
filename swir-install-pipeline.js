/* SWIR Install Pipeline 1.2 — VERIFY → TRUST → RESOLVE → PERMISSIONS → TRANSACTION → INSTALL */
(() => {
  'use strict';

  const SCHEMA = 'swir.install-pipeline/1.0';
  const VERSION = '1.2.0';
  const TRANSACTION_SCHEMA = 'swir.package-transaction/1.0';
  const TRANSACTION_KEY = 'package.transactions.v1';
  const TRANSACTION_LIMIT = 50;
  const STAGES = Object.freeze(['INTEGRITY','TRUST','DEPENDENCIES','PERMISSIONS','TRANSACTION','INSTALL']);
  const CATALOG_SECURITY_FIELDS = Object.freeze([
    'schema','id','packageId','name','version','author','category','type','entry','desktop',
    'permissions','associations','appData','compatibility','dependencies','optionalDependencies',
    'integrity','signature'
  ]);

  const catalog = () => Array.isArray(globalThis.SWIR_PACKAGE_CATALOG) ? globalThis.SWIR_PACKAGE_CATALOG : [];
  const platform = () => globalThis.SwirPlatform || null;
  const integrity = () => globalThis.SwirPackageIntegrity || null;
  const resolver = () => globalThis.SwirPackageResolver || null;

  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
      return out;
    }
    return value === undefined ? null : value;
  }

  function clone(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function catalogSecurityView(pkg) {
    const out = {};
    for (const field of CATALOG_SECURITY_FIELDS) out[field] = stable(pkg?.[field]);
    return out;
  }

  function sameCatalogPackage(manifest) {
    if (!manifest || typeof manifest !== 'object') return false;
    const official = catalog().find(item => item.id === manifest.id && item.packageId === manifest.packageId && String(item.version || '') === String(manifest.version || ''));
    if (!official) return false;
    return JSON.stringify(catalogSecurityView(manifest)) === JSON.stringify(catalogSecurityView(official));
  }

  function stage(name, ok, state, details = null) {
    return Object.freeze({ name, ok:!!ok, state:String(state || (ok ? 'READY' : 'BLOCKED')), details });
  }

  function txId() {
    const random = globalThis.crypto?.getRandomValues ? [...globalThis.crypto.getRandomValues(new Uint32Array(2))].map(x=>x.toString(36)).join('') : Math.random().toString(36).slice(2);
    return `tx-${Date.now().toString(36)}-${random}`;
  }

  async function readTransactions() {
    const api = platform();
    if (!api?.storage?.get) throw new Error('Transaction journal storage unavailable');
    const value = await api.storage.get(TRANSACTION_KEY, []);
    return Array.isArray(value) ? value : [];
  }

  async function writeTransactions(list) {
    const api = platform();
    if (!api?.storage?.set) throw new Error('Transaction journal storage unavailable');
    const bounded = (Array.isArray(list) ? list : []).slice(-TRANSACTION_LIMIT);
    await api.storage.set(TRANSACTION_KEY, bounded);
    return bounded;
  }

  async function beginTransaction(input) {
    const now = Date.now();
    const record = {
      schema:TRANSACTION_SCHEMA,
      id:txId(),
      action:String(input.action || 'install'),
      packageId:String(input.packageId || ''),
      fromVersion:input.fromVersion == null ? null : String(input.fromVersion),
      toVersion:input.toVersion == null ? null : String(input.toVersion),
      status:'PREPARED',
      startedAt:now,
      updatedAt:now,
      completedAt:null,
      error:null,
      rollback:{
        available:true,
        performed:false,
        mode:input.rollbackMode || (input.previousPackage ? 'RESTORE' : 'REMOVE'),
        previousPackage:clone(input.previousPackage || null),
        previousPermissions:clone(input.previousPermissions || {}),
        touchedPermissions:[...(input.touchedPermissions || [])]
      }
    };
    const list = await readTransactions();
    list.push(record);
    await writeTransactions(list);
    return clone(record);
  }

  async function patchTransaction(id, patch) {
    const list = await readTransactions();
    const index = list.findIndex(item => item?.id === id);
    if (index < 0) throw new Error(`Transaction not found: ${id}`);
    const current = list[index];
    const next = {
      ...current,
      ...clone(patch || {}),
      rollback:{ ...(current.rollback || {}), ...(clone(patch?.rollback || {})) },
      updatedAt:Date.now()
    };
    list[index] = next;
    await writeTransactions(list);
    return clone(next);
  }

  async function findInstalled(id) {
    const api = platform();
    if (!api?.packages?.list) return null;
    const list = await api.packages.list();
    return (Array.isArray(list) ? list : []).find(item => item?.id === id && item?.installed !== false) || null;
  }

  async function permissionSnapshot(appId, names) {
    const api = platform();
    const result = {};
    for (const permission of [...new Set((names || []).map(String))]) {
      try { result[permission] = (await api?.permissions?.get?.(appId, permission))?.value === true; }
      catch (_) { result[permission] = false; }
    }
    return result;
  }

  async function restorePermissions(appId, snapshot, touched) {
    const api = platform();
    if (!api?.permissions?.set) return;
    for (const permission of [...new Set((touched || []).map(String))]) {
      await api.permissions.set(appId, permission, snapshot?.[permission] === true);
    }
  }

  async function performRollback(record, reason = 'ROLLBACK_REQUESTED') {
    const api = platform();
    if (!api?.packages?.install || !api?.packages?.remove) throw new Error('Package service unavailable for rollback');
    const rb = record?.rollback;
    if (!rb?.available) throw new Error('Rollback metadata unavailable');
    const appId = record.packageId;
    if (rb.mode === 'RESTORE') {
      if (!rb.previousPackage) throw new Error('Rollback package snapshot missing');
      await api.packages.install(clone(rb.previousPackage));
    } else if (rb.mode === 'REMOVE') {
      await api.packages.remove(appId);
    } else {
      throw new Error(`Unknown rollback mode: ${rb.mode}`);
    }
    await restorePermissions(appId, rb.previousPermissions || {}, rb.touchedPermissions || []);
    return patchTransaction(record.id, {
      status:'ROLLED_BACK',
      completedAt:Date.now(),
      error:reason,
      rollback:{ performed:true, performedAt:Date.now(), reason }
    });
  }

  async function rollback(transactionId, options = {}) {
    if (options.approved !== true) throw new Error('Explicit rollback approval required');
    const list = await readTransactions();
    const record = list.find(item => item?.id === transactionId);
    if (!record) throw new Error(`Transaction not found: ${transactionId}`);
    if (record.rollback?.performed) return clone(record);
    if (!['COMMITTED','FAILED','ROLLBACK_FAILED'].includes(record.status)) throw new Error(`Transaction cannot be rolled back from state ${record.status}`);
    return performRollback(record, options.reason || 'MANUAL_ROLLBACK');
  }

  async function prepare(manifest, options = {}) {
    if (!manifest || typeof manifest !== 'object') throw new Error('Package manifest required');
    const integ = integrity(), res = resolver();
    if (!integ) throw new Error('Package Integrity service unavailable');
    if (!res) throw new Error('Package Resolver unavailable');

    const officialCatalog = sameCatalogPackage(manifest);
    const hasSignature = !!manifest.signature;
    const integrityPlan = await integ.plan(manifest, {
      verifyEntry: options.verifyEntry === true || !!manifest?.integrity?.entrySha256,
      verifySignature: hasSignature,
      trustStore: globalThis.SwirTrustedKeys
    });

    let trustOk = integrityPlan.signature?.ok !== false;
    let trustState = integrityPlan.signature?.state || 'UNSIGNED';
    if (!hasSignature) {
      trustOk = officialCatalog && options.allowUnsignedCatalog !== false;
      trustState = trustOk ? 'UNSIGNED_CATALOG' : 'UNSIGNED_BLOCKED';
    }

    const manifestOk = integrityPlan.manifest?.ok !== false;
    const entryOk = integrityPlan.entry?.ok !== false;
    const dependencyPlan = await res.planInstall(manifest);
    const permissions = Array.isArray(manifest.permissions) ? [...new Set(manifest.permissions.map(String))] : [];
    const stages = [
      stage('INTEGRITY', manifestOk && entryOk, manifestOk && entryOk ? 'VERIFIED' : 'BLOCKED', integrityPlan),
      stage('TRUST', trustOk, trustState, integrityPlan.signature),
      stage('DEPENDENCIES', dependencyPlan.ok, dependencyPlan.ok ? 'SATISFIED' : 'BLOCKED', dependencyPlan),
      stage('PERMISSIONS', true, permissions.length ? 'REVIEW_REQUIRED' : 'NONE', { permissions }),
      stage('TRANSACTION', true, 'JOURNAL_REQUIRED', { schema:TRANSACTION_SCHEMA }),
      stage('INSTALL', false, 'AWAITING_APPROVAL', null)
    ];
    const blockers = stages.filter(x => ['INTEGRITY','TRUST','DEPENDENCIES'].includes(x.name) && !x.ok);
    return Object.freeze({
      schema:SCHEMA,
      pipelineVersion:VERSION,
      transactionSchema:TRANSACTION_SCHEMA,
      ok:blockers.length === 0,
      packageId:manifest.packageId || manifest.id || null,
      version:manifest.version || null,
      officialCatalog,
      signed:hasSignature,
      stages,
      blockers:blockers.map(x => `${x.name}: ${x.state}`),
      permissions,
      next:blockers.length ? 'BLOCK' : (permissions.length ? 'REVIEW_PERMISSIONS' : 'INSTALL')
    });
  }

  async function install(manifest, options = {}) {
    if (options.approved !== true) throw new Error('Explicit installation approval required');
    const plan = await prepare(manifest, options);
    if (!plan.ok) throw new Error(plan.blockers.join(' • ') || 'Installation blocked');
    const api = platform();
    if (!api?.packages?.install || !api?.packages?.remove) throw new Error('Package service unavailable');
    if (!api?.storage?.get || !api?.storage?.set) throw new Error('Transaction journal storage unavailable');

    const requested = plan.permissions;
    const approvedPermissions = Array.isArray(options.approvedPermissions) ? [...new Set(options.approvedPermissions.map(String))] : requested;
    const unknown = approvedPermissions.filter(p => !requested.includes(p));
    if (unknown.length) throw new Error(`Unrequested permissions cannot be granted: ${unknown.join(', ')}`);
    const denied = requested.filter(p => !approvedPermissions.includes(p));
    if (denied.length) throw new Error(`Required permissions not approved: ${denied.join(', ')}`);

    const previous = await findInstalled(manifest.id);
    if (options.requireExisting === true && !previous) throw new Error('Package update requires an installed previous version');
    const touchedPermissions = [...new Set([...(previous?.permissions || []), ...requested])];
    const previousPermissions = await permissionSnapshot(manifest.id, touchedPermissions);
    const tx = await beginTransaction({
      action:previous ? 'update' : 'install',
      packageId:manifest.id,
      fromVersion:previous?.version || null,
      toVersion:manifest.version || null,
      previousPackage:previous,
      previousPermissions,
      touchedPermissions,
      rollbackMode:previous ? 'RESTORE' : 'REMOVE'
    });

    try {
      await patchTransaction(tx.id, { status:'APPLYING' });
      await api.packages.install({
        ...manifest,
        source: manifest.source || (plan.officialCatalog ? 'SWIR Store Official' : 'SWIR Package'),
        kind:'swir-app-package',
        trustState:plan.stages.find(x=>x.name==='TRUST')?.state || 'UNKNOWN',
        verification:{ schema:SCHEMA, pipelineVersion:VERSION, transactionSchema:TRANSACTION_SCHEMA, checkedAt:Date.now(), signed:plan.signed, officialCatalog:plan.officialCatalog },
        installed:true
      });
      for (const permission of touchedPermissions) await api.permissions?.set?.(manifest.id, permission, approvedPermissions.includes(permission));
      const committed = await patchTransaction(tx.id, { status:'COMMITTED', completedAt:Date.now() });
      return Object.freeze({ ...plan, ok:true, next:'COMPLETE', installed:true, updated:!!previous, approvedPermissions, transaction:committed });
    } catch (error) {
      let rollbackError = null;
      try {
        const latest = (await readTransactions()).find(item => item.id === tx.id) || tx;
        await performRollback(latest, `AUTO_ROLLBACK: ${String(error?.message || error)}`);
      } catch (rbError) {
        rollbackError = rbError;
        await patchTransaction(tx.id, { status:'ROLLBACK_FAILED', completedAt:Date.now(), error:String(error?.message || error), rollback:{ performed:false, error:String(rbError?.message || rbError) } });
      }
      const suffix = rollbackError ? `; rollback failed: ${rollbackError.message || rollbackError}` : '; changes rolled back';
      throw new Error(`Package transaction failed: ${error?.message || error}${suffix}`);
    }
  }

  async function update(manifest, options = {}) {
    return install(manifest, { ...options, requireExisting:true });
  }

  async function remove(manifest, options = {}) {
    if (options.approved !== true) throw new Error('Explicit removal approval required');
    const res = resolver();
    if (!res) throw new Error('Package Resolver unavailable');
    const removal = await res.planRemove(manifest);
    if (!removal.ok) throw new Error(removal.errors?.join(' • ') || 'Removal blocked by dependencies');
    const api = platform();
    if (!api?.packages?.remove || !api?.packages?.install) throw new Error('Package service unavailable');
    if (!api?.storage?.get || !api?.storage?.set) throw new Error('Transaction journal storage unavailable');

    const previous = await findInstalled(manifest.id);
    if (!previous) throw new Error('Package is not installed');
    const touchedPermissions = [...new Set((previous.permissions || manifest.permissions || []).map(String))];
    const previousPermissions = await permissionSnapshot(manifest.id, touchedPermissions);
    const tx = await beginTransaction({
      action:'remove',
      packageId:manifest.id,
      fromVersion:previous.version || manifest.version || null,
      toVersion:null,
      previousPackage:previous,
      previousPermissions,
      touchedPermissions,
      rollbackMode:'RESTORE'
    });

    try {
      await patchTransaction(tx.id, { status:'APPLYING' });
      await api.packages.remove(manifest.id);
      for (const permission of touchedPermissions) await api.permissions?.set?.(manifest.id, permission, false);
      const committed = await patchTransaction(tx.id, { status:'COMMITTED', completedAt:Date.now() });
      return { ok:true, schema:SCHEMA, pipelineVersion:VERSION, transactionSchema:TRANSACTION_SCHEMA, packageId:manifest.packageId || manifest.id, state:'REMOVED', transaction:committed };
    } catch (error) {
      let rollbackError = null;
      try {
        const latest = (await readTransactions()).find(item => item.id === tx.id) || tx;
        await performRollback(latest, `AUTO_ROLLBACK: ${String(error?.message || error)}`);
      } catch (rbError) {
        rollbackError = rbError;
        await patchTransaction(tx.id, { status:'ROLLBACK_FAILED', completedAt:Date.now(), error:String(error?.message || error), rollback:{ performed:false, error:String(rbError?.message || rbError) } });
      }
      const suffix = rollbackError ? `; rollback failed: ${rollbackError.message || rollbackError}` : '; changes rolled back';
      throw new Error(`Package removal transaction failed: ${error?.message || error}${suffix}`);
    }
  }

  async function transactions(options = {}) {
    const list = await readTransactions();
    const packageId = options.packageId == null ? null : String(options.packageId);
    const filtered = packageId ? list.filter(item => item?.packageId === packageId) : list;
    return clone(filtered).reverse();
  }

  function info() {
    return { schema:SCHEMA, version:VERSION, stages:[...STAGES], integrity:!!integrity(), trust:!!globalThis.SwirTrustedKeys, resolver:!!resolver(), platform:!!platform(), strictCatalogMatching:true, transactionSchema:TRANSACTION_SCHEMA, transactionLimit:TRANSACTION_LIMIT, rollback:true };
  }

  globalThis.SwirInstallPipeline = Object.freeze({
    meta:Object.freeze({ name:'SWIR Install Pipeline', version:VERSION, schema:SCHEMA, flow:STAGES.join(' → '), strictCatalogMatching:true, transactionSchema:TRANSACTION_SCHEMA }),
    prepare, install, update, remove, rollback, transactions, info, sameCatalogPackage, catalogSecurityView
  });
})();
