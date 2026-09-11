const TRUSTED_SOURCE_CLASSES = new Set([
  'kernel-in-tree',
  'linux-firmware',
  'distribution-repository',
  'fwupd-lvfs',
  'vendor-official-repository'
]);

function uniqueStrings(values) {
  return [...new Set((values || []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))].sort();
}

function trustedSources(device) {
  return (device?.catalog?.recommendedSources || []).filter(source =>
    source && TRUSTED_SOURCE_CLASSES.has(source.class) && typeof source.ref === 'string' && source.ref.trim()
  );
}

function aggregateSupport(device, catalog) {
  const ids = new Set(device?.catalog?.entryIds || []);
  const entries = (catalog?.entries || []).filter(entry => ids.has(entry.id));
  return {
    modules: uniqueStrings(entries.flatMap(entry => entry.support?.kernelModules || [])),
    firmware: uniqueStrings(entries.flatMap(entry => entry.support?.firmware || [])),
    packages: uniqueStrings(entries.flatMap(entry => entry.support?.packages || []))
  };
}

function rollbackMode(sources) {
  if (!sources.length) return 'not-required';
  if (sources.some(source => source.rollback === true)) return 'source-supported';
  return 'required-before-apply';
}

function operationId(deviceKey, kind, index) {
  return `${deviceKey}:${kind}:${index}`.replace(/[^A-Za-z0-9._:-]/g, '_');
}

function hostFacts(snapshot) {
  const distro = snapshot?.host?.distribution || {};
  const capabilities = snapshot?.host?.capabilities || {};
  return {
    distribution: {
      id: distro.id || 'unknown',
      versionId: distro.versionId ?? null,
      family: distro.family || 'unknown'
    },
    fwupdAvailable: capabilities.fwupd?.available === true,
    lvfsMetadataPresent: capabilities.fwupd?.lvfsMetadataPresent === true,
    packageManagers: uniqueStrings(capabilities.packageManagers || []),
    repositoryManagers: uniqueStrings((capabilities.repositoryConfig || []).map(item => item?.manager))
  };
}

export function resolveDriverPlan(snapshot, catalog, { now = new Date() } = {}) {
  if (snapshot?.schema !== 'swir.hardware-snapshot/0.2' || snapshot?.host?.readOnly !== true) {
    throw new Error('Driver resolver requires a trusted read-only hardware snapshot');
  }

  const facts = hostFacts(snapshot);
  const operations = [];
  let healthy = 0;
  let attention = 0;
  let matched = 0;

  for (const device of snapshot.devices || []) {
    const isMatched = device?.catalog?.matched === true;
    if (isMatched) matched += 1;
    const support = aggregateSupport(device, catalog);
    const sources = trustedSources(device);
    const moduleLoaded = device?.driver?.status === 'loaded' && typeof device?.driver?.module === 'string';
    const expectedModuleLoaded = moduleLoaded && (support.modules.length === 0 || support.modules.includes(device.driver.module));

    if (expectedModuleLoaded) {
      healthy += 1;
    } else if (isMatched) {
      attention += 1;
    }

    let index = 0;
    const push = (kind, reason, extra = {}) => {
      operations.push({
        id: operationId(device.key, kind, ++index),
        deviceKey: device.key,
        kind,
        state: 'proposed',
        requiresPrivilege: kind !== 'diagnose-unbound',
        reason,
        sources,
        rollback: rollbackMode(sources),
        ...extra
      });
    };

    if (device?.driver?.status === 'unbound' && isMatched) {
      push('diagnose-unbound', 'Device exposes a modalias but no driver is currently bound.', {
        modalias: device.driver.modalias || null,
        moduleCandidates: support.modules
      });
    }

    if (support.modules.length && !expectedModuleLoaded) {
      push('review-module', 'Catalog contains Linux kernel module candidates that require review before any privileged change.', {
        modalias: device?.driver?.modalias || null,
        moduleCandidates: support.modules
      });
    }

    if (support.firmware.length) {
      push('review-firmware', 'Catalog contains firmware requirements; verify package/source state before installation.', {
        firmwareCandidates: support.firmware
      });
    }

    if (support.packages.length) {
      const managerHint = facts.packageManagers[0] || null;
      push('review-package', managerHint
        ? `Catalog contains distribution package candidates; resolve through trusted ${managerHint} repositories only.`
        : 'Catalog contains distribution package candidates, but no supported package manager was detected.', {
        packageManager: managerHint,
        packageCandidates: support.packages
      });
    }

    if (sources.some(source => source.class === 'fwupd-lvfs')) {
      push('review-fwupd', facts.fwupdAvailable
        ? 'fwupd is available; query signed LVFS metadata before proposing any firmware mutation.'
        : 'Catalog recommends fwupd/LVFS, but fwupd is not currently available on this host.', {
        capability: facts.fwupdAvailable ? 'available' : 'unavailable'
      });
    }
  }

  return {
    schema: 'swir.driver-plan/0.1',
    generatedAt: now.toISOString(),
    mode: 'preview',
    readOnly: true,
    autoExecutable: false,
    host: facts,
    summary: {
      devices: (snapshot.devices || []).length,
      matched,
      healthy,
      attention,
      operations: operations.length
    },
    operations
  };
}

export function assertSafeDriverPlan(plan) {
  if (plan?.schema !== 'swir.driver-plan/0.1') throw new Error('Driver plan schema mismatch');
  if (plan?.mode !== 'preview' || plan?.readOnly !== true || plan?.autoExecutable !== false) {
    throw new Error('Driver plan must remain preview-only and non-executable');
  }
  for (const operation of plan.operations || []) {
    for (const source of operation.sources || []) {
      if (!TRUSTED_SOURCE_CLASSES.has(source.class)) {
        throw new Error(`Untrusted driver source class: ${source.class}`);
      }
    }
    if (operation.requiresPrivilege && operation.rollback === 'not-required') {
      throw new Error(`Privileged operation ${operation.id} must declare rollback handling`);
    }
  }
  return true;
}
