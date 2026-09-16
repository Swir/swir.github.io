const SUPPORTED_MANAGERS = new Set(['apt', 'dnf', 'rpm-ostree', 'pacman', 'zypper']);
const OPERATIONS = new Set(['install', 'update', 'remove']);
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9+._:@-]{0,127}$/;

const FAMILY_PREFERENCE = Object.freeze({
  debian: ['apt'],
  fedora: ['rpm-ostree', 'dnf'],
  arch: ['pacman'],
  suse: ['zypper'],
  unknown: ['apt', 'dnf', 'rpm-ostree', 'pacman', 'zypper']
});

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(value => typeof value === 'string' && value.length > 0))];
}

function validatePackageName(value) {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) throw new Error('invalid distribution package sourceRef');
  return value;
}

export function selectDistributionPackageManager(host = {}) {
  const available = new Set(uniqueStrings(host?.capabilities?.packageManagers).filter(name => SUPPORTED_MANAGERS.has(name)));
  const family = typeof host?.distribution?.family === 'string' ? host.distribution.family : 'unknown';
  const preference = FAMILY_PREFERENCE[family] || FAMILY_PREFERENCE.unknown;
  const selected = preference.find(name => available.has(name)) || [...available][0] || null;
  return {
    family,
    available: [...available].sort(),
    selected
  };
}

export function validateDistributionPackageManifest(manifest, options = {}) {
  assertObject(manifest, 'package manifest');
  if (manifest.schema !== 'swir.package-provider/0.2') throw new Error('unsupported package provider schema');
  if (!Array.isArray(manifest.targetEditions) || !manifest.targetEditions.includes('system')) throw new Error('package does not target System Edition');
  if (manifest.executionClass !== 'linux-native') throw new Error('distribution provider accepts linux-native only');
  if (manifest.provider !== 'swir.package.system') throw new Error('distribution provider requires swir.package.system');
  assertObject(manifest.package, 'package');
  const packageName = validatePackageName(manifest.package.sourceRef);
  assertObject(manifest.trust, 'trust');
  if (manifest.trust.sourceClass !== 'distribution-repository') throw new Error('distribution provider requires distribution-repository trust');
  if (manifest.trust.signatureRequired !== true) throw new Error('distribution repository signatures must be required');
  if (options.trustVerified === false) throw new Error('explicit trust verification failure');
  return { packageName };
}

function commandPreview(manager, operation, packageName) {
  if (manager === 'apt') {
    if (operation === 'install') return ['apt-get', 'install', '--', packageName];
    if (operation === 'update') return ['apt-get', 'install', '--only-upgrade', '--', packageName];
    return ['apt-get', 'remove', '--', packageName];
  }
  if (manager === 'dnf') return ['dnf', operation === 'update' ? 'upgrade' : operation, '--', packageName];
  if (manager === 'rpm-ostree') {
    if (operation === 'install') return ['rpm-ostree', 'install', '--', packageName];
    if (operation === 'update') return ['rpm-ostree', 'upgrade'];
    return ['rpm-ostree', 'uninstall', '--', packageName];
  }
  if (manager === 'pacman') {
    if (operation === 'install') return ['pacman', '-S', '--', packageName];
    if (operation === 'update') return ['pacman', '-S', '--needed', '--', packageName];
    return ['pacman', '-R', '--', packageName];
  }
  if (manager === 'zypper') {
    if (operation === 'install') return ['zypper', '--non-interactive', 'install', '--', packageName];
    if (operation === 'update') return ['zypper', '--non-interactive', 'update', '--', packageName];
    return ['zypper', '--non-interactive', 'remove', '--', packageName];
  }
  throw new Error('unsupported distribution package manager');
}

function rollbackPolicy(manager, operation) {
  if (manager === 'rpm-ostree') {
    return { supported: true, mechanism: 'deployment-rollback', note: 'Rollback is provider-managed and still requires a journaled privileged transaction.' };
  }
  if (operation === 'remove') {
    return { supported: false, mechanism: null, note: 'Removal rollback requires a captured package/version transaction snapshot before mutation.' };
  }
  return { supported: false, mechanism: null, note: 'Version-aware rollback must be resolved by the future privileged package transaction service.' };
}

export function buildDistributionPackagePlan(operation, manifest, options = {}) {
  if (!OPERATIONS.has(operation)) throw new Error('unsupported package operation');
  const { packageName } = validateDistributionPackageManifest(manifest, options);
  const managerState = selectDistributionPackageManager(options.host);
  const manager = options.manager || managerState.selected;
  if (!manager || !SUPPORTED_MANAGERS.has(manager)) throw new Error('no supported distribution package manager available');
  if (!managerState.available.includes(manager)) throw new Error('selected distribution package manager is not available on host');

  const repositoryId = manifest.trust.repositoryId || null;
  if (repositoryId && options.allowlistedRepositories && !new Set(options.allowlistedRepositories).has(repositoryId)) {
    throw new Error('distribution repository is not allowlisted');
  }

  return {
    schema: 'swir.system-package-plan/0.1',
    mode: 'preview',
    readOnly: true,
    autoExecutable: false,
    provider: 'swir.package.system',
    executionClass: 'linux-native',
    operation,
    package: {
      id: manifest.id,
      sourceRef: packageName,
      nativeEntryPoint: manifest.package.nativeEntryPoint || null
    },
    host: {
      distribution: options.host?.distribution || { id: 'unknown', family: managerState.family },
      packageManager: manager,
      availablePackageManagers: managerState.available
    },
    source: {
      class: 'distribution-repository',
      repositoryId
    },
    trust: {
      signatureVerificationRequired: true,
      arbitraryRepositoryUrlAllowed: false
    },
    transaction: {
      requiresPrivilege: true,
      journalRequired: true,
      healthCheckRequired: operation !== 'remove',
      rollback: rollbackPolicy(manager, operation)
    },
    commandPreview: commandPreview(manager, operation, packageName)
  };
}

export class DistributionPackageProvider {
  #host;
  #allowlistedRepositories;

  constructor({ host, allowlistedRepositories = [] } = {}) {
    this.#host = host || { distribution: { id: 'unknown', family: 'unknown' }, capabilities: { packageManagers: [] } };
    this.#allowlistedRepositories = uniqueStrings(allowlistedRepositories);
  }

  probe() {
    const managers = selectDistributionPackageManager(this.#host);
    return {
      schema: 'swir.package-provider-probe/0.1',
      provider: 'swir.package.system',
      available: Boolean(managers.selected),
      readOnly: true,
      distribution: this.#host.distribution || { id: 'unknown', family: managers.family },
      selectedPackageManager: managers.selected,
      availablePackageManagers: managers.available
    };
  }

  resolve(manifest, options = {}) {
    const { packageName } = validateDistributionPackageManifest(manifest, options);
    return {
      schema: 'swir.package-provider-resolution/0.1',
      provider: 'swir.package.system',
      packageId: manifest.id,
      sourceRef: packageName,
      sourceClass: 'distribution-repository',
      state: 'unqueried',
      reason: 'Architecture 0.1 provider does not query or mutate the package database outside the privileged broker.'
    };
  }

  planInstall(manifest, options = {}) { return this.#plan('install', manifest, options); }
  planUpdate(manifest, options = {}) { return this.#plan('update', manifest, options); }
  planRemove(manifest, options = {}) { return this.#plan('remove', manifest, options); }

  #plan(operation, manifest, options) {
    return buildDistributionPackagePlan(operation, manifest, {
      ...options,
      host: options.host || this.#host,
      allowlistedRepositories: options.allowlistedRepositories || this.#allowlistedRepositories
    });
  }

  install() { throw new Error('PACKAGE_MUTATION_BROKER_REQUIRED: preview provider cannot install packages'); }
  update() { throw new Error('PACKAGE_MUTATION_BROKER_REQUIRED: preview provider cannot update packages'); }
  remove() { throw new Error('PACKAGE_MUTATION_BROKER_REQUIRED: preview provider cannot remove packages'); }
  rollback() { throw new Error('PACKAGE_MUTATION_BROKER_REQUIRED: rollback requires the future privileged transaction service'); }
}

export const DistributionPackageProviderPolicy = Object.freeze({
  schema: 'swir.system-package-plan/0.1',
  provider: 'swir.package.system',
  executionClass: 'linux-native',
  sourceClass: 'distribution-repository',
  supportedManagers: [...SUPPORTED_MANAGERS],
  previewOnly: true,
  autoExecutable: false,
  signatureVerificationRequired: true,
  arbitraryRepositoryUrls: false,
  privilegedMutationRequiresPlan: true,
  privilegedMutationRequiresJournal: true
});
