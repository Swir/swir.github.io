const RUNTIME_PROVIDERS = new Set(['swir.compat.wine', 'swir.compat.proton']);
const OPERATIONS = new Set(['install', 'update']);
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9+._:@-]{0,127}$/;

function fail(code, message, details = null) {
  const error = new Error(message);
  error.name = 'WindowsCompatibilityRuntimeProvisionerError';
  error.code = code;
  if (details != null) error.details = details;
  throw error;
}

function assert(condition, code, message, details = null) {
  if (!condition) fail(code, message, details);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function validateRuntimeProvider(provider) {
  assert(RUNTIME_PROVIDERS.has(provider), 'UNSUPPORTED_RUNTIME_PROVIDER', 'Unsupported Windows compatibility runtime provider');
  return provider;
}

function validateOperation(operation) {
  assert(OPERATIONS.has(operation), 'UNSUPPORTED_OPERATION', 'Runtime provisioning supports install/update only');
  return operation;
}

function validatePackageManifest(manifest) {
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'INVALID_PACKAGE_MANIFEST', 'Runtime package manifest must be an object');
  assert(manifest.schema === 'swir.package-provider/0.2', 'UNSUPPORTED_PACKAGE_SCHEMA', 'Runtime package manifest schema is unsupported');
  assert(Array.isArray(manifest.targetEditions) && manifest.targetEditions.includes('system'), 'WRONG_EDITION', 'Runtime package must target System Edition');
  assert(manifest.executionClass === 'linux-native', 'WRONG_EXECUTION_CLASS', 'Runtime provisioning package must be linux-native');
  assert(manifest.provider === 'swir.package.system', 'WRONG_PACKAGE_PROVIDER', 'Runtime provisioning must use the reviewed distribution package stack');
  assert(manifest.package && typeof manifest.package === 'object' && !Array.isArray(manifest.package), 'INVALID_PACKAGE', 'Runtime package metadata is required');
  assert(typeof manifest.package.sourceRef === 'string' && PACKAGE_NAME.test(manifest.package.sourceRef), 'INVALID_PACKAGE_SOURCE', 'Runtime package sourceRef must be a distribution package name');
  assert(manifest.trust && typeof manifest.trust === 'object' && !Array.isArray(manifest.trust), 'INVALID_TRUST', 'Runtime package trust metadata is required');
  assert(manifest.trust.sourceClass === 'distribution-repository', 'WRONG_SOURCE_CLASS', 'Runtime provisioning requires a distribution repository');
  assert(manifest.trust.signatureRequired === true, 'SIGNATURE_REQUIRED', 'Runtime package signatures must be required');
  assert(typeof manifest.trust.repositoryId === 'string' && manifest.trust.repositoryId.length > 0, 'REPOSITORY_ID_REQUIRED', 'Runtime package repositoryId is required');
  return clone(manifest);
}

export function validateCompatibilityRuntimeProvisioningCatalog(catalog) {
  assert(catalog && typeof catalog === 'object' && !Array.isArray(catalog), 'INVALID_CATALOG', 'Compatibility runtime provisioning catalog must be an object');
  assert(catalog.schema === 'swir.compat-runtime-provisioning-catalog/0.1', 'UNSUPPORTED_CATALOG_SCHEMA', 'Compatibility runtime provisioning catalog schema is unsupported');
  assert(Array.isArray(catalog.entries), 'INVALID_CATALOG_ENTRIES', 'Compatibility runtime provisioning catalog entries must be an array');
  const seen = new Set();
  const entries = catalog.entries.map(entry => {
    assert(entry && typeof entry === 'object' && !Array.isArray(entry), 'INVALID_CATALOG_ENTRY', 'Compatibility runtime catalog entry must be an object');
    const runtimeProvider = validateRuntimeProvider(entry.runtimeProvider);
    assert(!seen.has(runtimeProvider), 'DUPLICATE_RUNTIME_PROVIDER', `Duplicate runtime provisioning entry for ${runtimeProvider}`);
    seen.add(runtimeProvider);
    const packageManifest = validatePackageManifest(entry.packageManifest);
    assert(entry.runtimeExecutablePath == null && entry.downloadUrl == null && entry.repositoryUrl == null, 'UNTRUSTED_RUNTIME_SOURCE', 'Runtime catalog cannot provide executable paths or download/repository URLs');
    return Object.freeze({
      runtimeProvider,
      packageManifest: Object.freeze(packageManifest),
      channel: typeof entry.channel === 'string' && entry.channel.length > 0 ? entry.channel : 'distribution',
      notes: typeof entry.notes === 'string' ? entry.notes : null
    });
  });
  assert(entries.length > 0, 'EMPTY_CATALOG', 'Compatibility runtime provisioning catalog cannot be empty');
  return Object.freeze({
    schema: catalog.schema,
    entries: Object.freeze(entries)
  });
}

function inventoryFrom(registryFactory) {
  const registry = registryFactory();
  assert(registry && typeof registry.discover === 'function', 'INVALID_RUNTIME_REGISTRY', 'Runtime registry factory must return a discover-capable registry');
  const inventory = registry.discover();
  assert(inventory && inventory.schema === 'swir.compat-runtime-inventory/0.1' && Array.isArray(inventory.runtimes), 'INVALID_RUNTIME_INVENTORY', 'Trusted runtime registry returned an invalid inventory');
  return clone(inventory);
}

function healthyRuntime(inventory, provider) {
  return inventory.runtimes.find(runtime => runtime?.provider === provider && runtime?.healthy === true) || null;
}

export class WindowsCompatibilityRuntimeProvisioner {
  #packageLayer;
  #registryFactory;
  #catalog;

  constructor({ packageLayer, registryFactory, catalog } = {}) {
    assert(packageLayer && typeof packageLayer.plan === 'function' && typeof packageLayer.execute === 'function' && typeof packageLayer.recoverPending === 'function', 'INVALID_PACKAGE_LAYER', 'System Package Provider layer with plan/execute/recoverPending is required');
    assert(typeof registryFactory === 'function', 'INVALID_RUNTIME_REGISTRY_FACTORY', 'Trusted runtime registry factory is required');
    this.#packageLayer = packageLayer;
    this.#registryFactory = registryFactory;
    this.#catalog = validateCompatibilityRuntimeProvisioningCatalog(catalog);
  }

  describe() {
    return Object.freeze({
      schema: 'swir.compat-runtime-provisioner/0.1',
      providers: this.#catalog.entries.map(entry => entry.runtimeProvider),
      packageProvider: 'swir.package.system',
      arbitraryDownloads: false,
      arbitraryRepositoryUrls: false,
      arbitraryExecutablePaths: false,
      postTransactionTrustedRediscoveryRequired: true,
      directPackageManagerExecution: false
    });
  }

  inventory() {
    return inventoryFrom(this.#registryFactory);
  }

  plan(runtimeProvider, operation = 'install') {
    validateRuntimeProvider(runtimeProvider);
    validateOperation(operation);
    const entry = this.#catalog.entries.find(item => item.runtimeProvider === runtimeProvider);
    assert(entry, 'RUNTIME_NOT_PROVISIONABLE', `No reviewed package mapping exists for ${runtimeProvider}`);
    const packagePlan = this.#packageLayer.plan(operation, clone(entry.packageManifest));
    assert(packagePlan && packagePlan.provider === 'swir.package.system', 'PACKAGE_PLAN_MISMATCH', 'Runtime package plan escaped the distribution package provider');
    assert(packagePlan.operation === operation, 'PACKAGE_OPERATION_MISMATCH', 'Runtime package plan operation mismatch');
    return Object.freeze({
      schema: 'swir.compat-runtime-provisioning-plan/0.1',
      runtimeProvider,
      operation,
      channel: entry.channel,
      package: clone(entry.packageManifest),
      packagePlan: clone(packagePlan),
      verifyWithTrustedRegistry: true
    });
  }

  async provision(runtimeProvider, operation = 'install', authorizationContext = {}) {
    validateRuntimeProvider(runtimeProvider);
    validateOperation(operation);
    assert(authorizationContext && typeof authorizationContext === 'object' && !Array.isArray(authorizationContext), 'INVALID_AUTHORIZATION_CONTEXT', 'Authorization context must be an object');
    const before = this.inventory();
    const existing = healthyRuntime(before, runtimeProvider);
    if (operation === 'install' && existing) {
      return Object.freeze({
        schema: 'swir.compat-runtime-provisioning-result/0.1',
        runtimeProvider,
        operation,
        state: 'already-present',
        runtime: clone(existing),
        packageResult: null,
        inventoryBefore: before,
        inventoryAfter: before
      });
    }

    const plan = this.plan(runtimeProvider, operation);
    const packageResult = await this.#packageLayer.execute(operation, clone(plan.package), clone(authorizationContext));
    const after = this.inventory();
    const runtime = healthyRuntime(after, runtimeProvider);
    if (!runtime) {
      fail('RUNTIME_VERIFICATION_FAILED', `Package transaction completed but no healthy ${runtimeProvider} runtime was accepted by the trusted registry`, {
        runtimeProvider,
        operation,
        packageResult: clone(packageResult),
        recoveryRequired: true
      });
    }
    return Object.freeze({
      schema: 'swir.compat-runtime-provisioning-result/0.1',
      runtimeProvider,
      operation,
      state: 'verified',
      runtime: clone(runtime),
      packageResult: clone(packageResult),
      inventoryBefore: before,
      inventoryAfter: after
    });
  }

  recoverPending(authorizationContext = {}) {
    assert(authorizationContext && typeof authorizationContext === 'object' && !Array.isArray(authorizationContext), 'INVALID_AUTHORIZATION_CONTEXT', 'Authorization context must be an object');
    return this.#packageLayer.recoverPending('swir.package.system', clone(authorizationContext));
  }
}

export const WindowsCompatibilityRuntimeProvisionerPolicy = Object.freeze({
  schema: 'swir.compat-runtime-provisioner/0.1',
  catalogSchema: 'swir.compat-runtime-provisioning-catalog/0.1',
  packageProvider: 'swir.package.system',
  supportedRuntimeProviders: [...RUNTIME_PROVIDERS],
  supportedOperations: [...OPERATIONS],
  arbitraryDownloads: false,
  arbitraryRepositoryUrls: false,
  arbitraryExecutablePaths: false,
  directPackageManagerExecution: false,
  trustedRuntimeRediscoveryRequired: true
});
