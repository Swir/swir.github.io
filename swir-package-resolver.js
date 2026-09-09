/* SWIR OS 1.7 — Package Dependency & Compatibility Resolver */
(() => {
  'use strict';

  const catalog = () => Array.isArray(window.SWIR_PACKAGE_CATALOG) ? window.SWIR_PACKAGE_CATALOG : [];
  const platform = () => window.SwirPlatform;
  const normalize = value => String(value ?? '0').trim().replace(/^v/i, '').split(/[+-]/)[0];
  const parts = value => normalize(value).split('.').map(x => Number.parseInt(x, 10) || 0);

  function compareVersions(a, b) {
    const aa = parts(a), bb = parts(b), len = Math.max(aa.length, bb.length, 3);
    for (let i = 0; i < len; i++) {
      const av = aa[i] || 0, bv = bb[i] || 0;
      if (av > bv) return 1;
      if (av < bv) return -1;
    }
    return 0;
  }
  const satisfies = (current, minimum) => !minimum || compareVersions(current, minimum) >= 0;

  function runtime() {
    let info = {};
    try { info = platform()?.system?.info?.() || {}; } catch (_) {}
    const sdk = window.SwirAppSDK?.meta || {};
    return Object.freeze({
      os: String(sdk.os || info.version || '1.7.0').match(/[0-9]+(?:\.[0-9]+){0,2}/)?.[0] || '1.7.0',
      sdk: String(sdk.version || '1.2.0'),
      platformApi: Number(info.platformApi || 2),
      edition: String(sdk.edition || info.edition || 'WEB').toUpperCase()
    });
  }

  async function installedPackages() {
    try {
      const list = await platform()?.packages?.list?.();
      if (Array.isArray(list)) return list.filter(x => x.installed !== false);
    } catch (_) {}
    let ids = [];
    try { ids = JSON.parse(localStorage.getItem('swir-installed-apps') || '[]'); } catch (_) {}
    return (Array.isArray(ids) ? ids : []).map(id => catalog().find(x => x.id === id) || { id, packageId: id, version: '0.0.0', installed: true });
  }

  function resolvePackage(ref) {
    if (!ref) return null;
    if (typeof ref === 'object') return ref;
    return catalog().find(x => x.id === ref || x.packageId === ref) || null;
  }

  function requirementSummary(pkg) {
    const c = pkg?.compatibility || {};
    return {
      minOS: c.minOS || null,
      minSDK: c.minSDK || null,
      platformApi: c.platformApi || null,
      editions: Array.isArray(c.editions) ? c.editions : [],
      dependencies: Array.isArray(pkg?.dependencies) ? pkg.dependencies : []
    };
  }

  async function checkCompatibility(ref, options = {}) {
    const pkg = resolvePackage(ref);
    if (!pkg) return { ok: false, errors: ['PACKAGE_NOT_FOUND'], warnings: [], runtime: runtime(), package: null, requirements: null };
    const rt = runtime(), req = requirementSummary(pkg), errors = [], warnings = [];
    if (req.minOS && !satisfies(rt.os, req.minOS)) errors.push(`Requires SWIR OS ${req.minOS}+ (current ${rt.os})`);
    if (req.minSDK && !satisfies(rt.sdk, req.minSDK)) errors.push(`Requires SWIR App SDK ${req.minSDK}+ (current ${rt.sdk})`);
    if (req.platformApi && rt.platformApi < Number(req.platformApi)) errors.push(`Requires Platform API ${req.platformApi}+ (current ${rt.platformApi})`);
    if (req.editions.length && !req.editions.map(x => String(x).toUpperCase()).includes(rt.edition)) errors.push(`Edition ${rt.edition} is not supported`);

    const installed = options.installed || await installedPackages();
    for (const dep of req.dependencies) {
      const dependency = resolvePackage(dep.packageId || dep.id);
      const found = installed.find(x => x.id === dependency?.id || x.packageId === dep.packageId || x.id === dep.id);
      if (!found) {
        errors.push(`Missing dependency: ${dep.packageId || dep.id}${dep.minVersion ? ` ${dep.minVersion}+` : ''}`);
        continue;
      }
      if (dep.minVersion && !satisfies(found.version || dependency?.version || '0.0.0', dep.minVersion)) {
        errors.push(`Dependency ${dep.packageId || dep.id} must be ${dep.minVersion}+ (installed ${found.version || 'unknown'})`);
      }
    }

    for (const dep of Array.isArray(pkg.optionalDependencies) ? pkg.optionalDependencies : []) {
      const dependency = resolvePackage(dep.packageId || dep.id);
      const found = installed.find(x => x.id === dependency?.id || x.packageId === dep.packageId || x.id === dep.id);
      if (!found) warnings.push(`Optional dependency unavailable: ${dep.packageId || dep.id}`);
      else if (dep.minVersion && !satisfies(found.version || dependency?.version || '0.0.0', dep.minVersion)) warnings.push(`Optional dependency ${dep.packageId || dep.id} is older than ${dep.minVersion}`);
    }

    return { ok: errors.length === 0, errors, warnings, runtime: rt, package: pkg, requirements: req };
  }

  async function dependentsOf(ref) {
    const pkg = resolvePackage(ref);
    if (!pkg) return [];
    const installed = await installedPackages();
    const ids = new Set([pkg.id, pkg.packageId]);
    return installed.map(x => resolvePackage(x.id || x.packageId) || x).filter(candidate =>
      candidate && candidate.id !== pkg.id && (candidate.dependencies || []).some(dep => ids.has(dep.id) || ids.has(dep.packageId))
    );
  }

  async function planInstall(ref) {
    const result = await checkCompatibility(ref);
    const missing = [];
    if (result.package) {
      const installed = await installedPackages();
      for (const dep of result.requirements.dependencies) {
        const dependency = resolvePackage(dep.packageId || dep.id);
        const found = installed.find(x => x.id === dependency?.id || x.packageId === dep.packageId || x.id === dep.id);
        if (!found && dependency) missing.push(dependency);
      }
    }
    return { ...result, missingDependencies: missing };
  }

  async function planRemove(ref) {
    const pkg = resolvePackage(ref);
    if (!pkg) return { ok: false, errors: ['PACKAGE_NOT_FOUND'], dependents: [] };
    const dependents = await dependentsOf(pkg);
    return {
      ok: dependents.length === 0,
      errors: dependents.length ? [`Required by: ${dependents.map(x => x.name || x.packageId || x.id).join(', ')}`] : [],
      dependents,
      package: pkg
    };
  }

  async function audit() {
    const installed = await installedPackages(), results = [];
    for (const item of installed) {
      const pkg = resolvePackage(item.id || item.packageId);
      if (!pkg) {
        results.push({ ok: false, package: item, errors: ['Installed package is not present in the active catalog'], warnings: [] });
        continue;
      }
      results.push(await checkCompatibility(pkg, { installed }));
    }
    return results;
  }

  window.SwirPackageResolver = Object.freeze({
    meta: Object.freeze({ name: 'SWIR Package Resolver', version: '1.0.0', schema: 'swir.dependencies/1.0' }),
    compareVersions,
    satisfies,
    runtime,
    resolvePackage,
    requirementSummary,
    installedPackages,
    checkCompatibility,
    planInstall,
    planRemove,
    dependentsOf,
    audit
  });
})();
