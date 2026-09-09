/* SWIR Install Pipeline 1.1 — VERIFY → TRUST → RESOLVE → PERMISSIONS → INSTALL */
(() => {
  'use strict';

  const SCHEMA = 'swir.install-pipeline/1.0';
  const VERSION = '1.1.0';
  const STAGES = Object.freeze(['INTEGRITY','TRUST','DEPENDENCIES','PERMISSIONS','INSTALL']);
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

  function catalogSecurityView(pkg) {
    const out = {};
    for (const field of CATALOG_SECURITY_FIELDS) out[field] = stable(pkg?.[field]);
    return out;
  }

  function sameCatalogPackage(manifest) {
    if (!manifest || typeof manifest !== 'object') return false;
    const official = catalog().find(item => item.id === manifest.id && item.packageId === manifest.packageId);
    if (!official) return false;
    return JSON.stringify(catalogSecurityView(manifest)) === JSON.stringify(catalogSecurityView(official));
  }

  function stage(name, ok, state, details = null) {
    return Object.freeze({ name, ok:!!ok, state:String(state || (ok ? 'READY' : 'BLOCKED')), details });
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
      stage('INSTALL', false, 'AWAITING_APPROVAL', null)
    ];
    const blockers = stages.filter(x => ['INTEGRITY','TRUST','DEPENDENCIES'].includes(x.name) && !x.ok);
    return Object.freeze({
      schema:SCHEMA,
      pipelineVersion:VERSION,
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
    if (!api?.packages?.install) throw new Error('Package service unavailable');

    const requested = plan.permissions;
    const approvedPermissions = Array.isArray(options.approvedPermissions) ? [...new Set(options.approvedPermissions.map(String))] : requested;
    const unknown = approvedPermissions.filter(p => !requested.includes(p));
    if (unknown.length) throw new Error(`Unrequested permissions cannot be granted: ${unknown.join(', ')}`);
    const denied = requested.filter(p => !approvedPermissions.includes(p));
    if (denied.length) throw new Error(`Required permissions not approved: ${denied.join(', ')}`);

    await api.packages.install({
      ...manifest,
      source: manifest.source || (plan.officialCatalog ? 'SWIR Store Official' : 'SWIR Package'),
      kind:'swir-app-package',
      trustState:plan.stages.find(x=>x.name==='TRUST')?.state || 'UNKNOWN',
      verification:{ schema:SCHEMA, pipelineVersion:VERSION, checkedAt:Date.now(), signed:plan.signed, officialCatalog:plan.officialCatalog },
      installed:true
    });
    for (const permission of approvedPermissions) await api.permissions?.set?.(manifest.id, permission, true);
    return Object.freeze({ ...plan, ok:true, next:'COMPLETE', installed:true, approvedPermissions });
  }

  async function remove(manifest, options = {}) {
    if (options.approved !== true) throw new Error('Explicit removal approval required');
    const res = resolver();
    if (!res) throw new Error('Package Resolver unavailable');
    const removal = await res.planRemove(manifest);
    if (!removal.ok) throw new Error(removal.errors?.join(' • ') || 'Removal blocked by dependencies');
    const api = platform();
    if (!api?.packages?.remove) throw new Error('Package service unavailable');
    await api.packages.remove(manifest.id);
    for (const permission of manifest.permissions || []) await api.permissions?.set?.(manifest.id, permission, false);
    return { ok:true, schema:SCHEMA, pipelineVersion:VERSION, packageId:manifest.packageId || manifest.id, state:'REMOVED' };
  }

  function info() {
    return { schema:SCHEMA, version:VERSION, stages:[...STAGES], integrity:!!integrity(), trust:!!globalThis.SwirTrustedKeys, resolver:!!resolver(), platform:!!platform(), strictCatalogMatching:true };
  }

  globalThis.SwirInstallPipeline = Object.freeze({
    meta:Object.freeze({ name:'SWIR Install Pipeline', version:VERSION, schema:SCHEMA, flow:STAGES.join(' → '), strictCatalogMatching:true }),
    prepare, install, remove, info, sameCatalogPackage, catalogSecurityView
  });
})();
