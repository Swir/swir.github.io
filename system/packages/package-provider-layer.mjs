const OPERATIONS = new Set(['install', 'update', 'remove']);
const LINUX_PROVIDERS = Object.freeze({
  'swir.package.system': Object.freeze({ kind: 'distribution', status: 'implemented' }),
  'swir.package.flatpak': Object.freeze({ kind: 'flatpak', status: 'planned' }),
  'swir.package.appimage': Object.freeze({ kind: 'appimage', status: 'planned' })
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function fail(code, message) {
  const error = new Error(message);
  error.name = 'SystemPackageProviderLayerError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function validateOperation(operation) {
  assert(OPERATIONS.has(operation), 'UNSUPPORTED_OPERATION', 'Unsupported package provider operation');
  return operation;
}

function validateManifest(manifest) {
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'INVALID_MANIFEST', 'Package manifest must be an object');
  assert(manifest.schema === 'swir.package-provider/0.2', 'UNSUPPORTED_SCHEMA', 'Unsupported package provider schema');
  assert(Array.isArray(manifest.targetEditions) && manifest.targetEditions.includes('system'), 'WRONG_EDITION', 'Package must target System Edition');
  assert(manifest.executionClass === 'linux-native', 'WRONG_EXECUTION_CLASS', 'System Package Provider layer accepts linux-native packages only');
  assert(Object.prototype.hasOwnProperty.call(LINUX_PROVIDERS, manifest.provider), 'UNSUPPORTED_PROVIDER', 'Unsupported Linux package provider');
  assert(manifest.package && typeof manifest.package === 'object' && !Array.isArray(manifest.package), 'INVALID_PACKAGE', 'Package metadata is required');
  return manifest.provider;
}

function validateAdapter(providerId, adapter) {
  assert(adapter && typeof adapter === 'object', 'INVALID_ADAPTER', `${providerId} adapter is required`);
  assert(typeof adapter.plan === 'function', 'INVALID_ADAPTER', `${providerId} adapter must implement plan()`);
  assert(typeof adapter.execute === 'function', 'INVALID_ADAPTER', `${providerId} adapter must implement execute()`);
  return adapter;
}

export class DistributionPackageStackAdapter {
  #stack;

  constructor(stack) {
    assert(stack && typeof stack.plan === 'function' && typeof stack.execute === 'function' && typeof stack.recoverPending === 'function', 'INVALID_DISTRIBUTION_STACK', 'System package stack must expose plan/execute/recoverPending');
    this.#stack = stack;
  }

  describe() {
    const stack = typeof this.#stack.describe === 'function' ? this.#stack.describe() : null;
    return Object.freeze({
      schema: 'swir.package-provider-adapter/0.1',
      provider: 'swir.package.system',
      kind: 'distribution',
      available: true,
      privilegedMutation: true,
      stack: clone(stack)
    });
  }

  plan(operation, manifest) {
    return this.#stack.plan(validateOperation(operation), clone(manifest));
  }

  execute(operation, manifest, authorizationContext = {}) {
    return this.#stack.execute(validateOperation(operation), clone(manifest), clone(authorizationContext));
  }

  recoverPending(authorizationContext = {}) {
    return this.#stack.recoverPending(clone(authorizationContext));
  }
}

export class SystemPackageProviderLayer {
  #adapters;

  constructor({ adapters = new Map() } = {}) {
    assert(adapters instanceof Map, 'INVALID_ADAPTER_MAP', 'Package provider adapters must be supplied as a Map');
    this.#adapters = new Map();
    for (const [providerId, adapter] of adapters.entries()) {
      assert(Object.prototype.hasOwnProperty.call(LINUX_PROVIDERS, providerId), 'UNSUPPORTED_PROVIDER', `Unknown package provider adapter: ${providerId}`);
      this.#adapters.set(providerId, validateAdapter(providerId, adapter));
    }
  }

  describe() {
    const providers = Object.entries(LINUX_PROVIDERS).map(([id, metadata]) => {
      const adapter = this.#adapters.get(id);
      return {
        id,
        kind: metadata.kind,
        roadmapStatus: metadata.status,
        available: Boolean(adapter),
        state: adapter ? 'ready' : 'not-provisioned',
        adapter: adapter && typeof adapter.describe === 'function' ? clone(adapter.describe()) : null
      };
    });
    return Object.freeze({
      schema: 'swir.system-package-provider-layer/0.1',
      executionClass: 'linux-native',
      providers,
      arbitraryProviderRegistration: false,
      directCommandExecution: false,
      privilegedMutationDelegated: true
    });
  }

  providerState(providerId) {
    assert(Object.prototype.hasOwnProperty.call(LINUX_PROVIDERS, providerId), 'UNSUPPORTED_PROVIDER', 'Unsupported Linux package provider');
    const adapter = this.#adapters.get(providerId);
    return Object.freeze({
      provider: providerId,
      kind: LINUX_PROVIDERS[providerId].kind,
      available: Boolean(adapter),
      state: adapter ? 'ready' : 'not-provisioned'
    });
  }

  plan(operation, manifest) {
    const providerId = validateManifest(manifest);
    const adapter = this.#requireAdapter(providerId);
    const result = adapter.plan(validateOperation(operation), clone(manifest));
    assert(result && typeof result === 'object', 'INVALID_PROVIDER_PLAN', 'Package provider returned an invalid plan');
    assert(result.provider === providerId, 'PROVIDER_PLAN_MISMATCH', 'Package provider plan identity mismatch');
    assert(result.operation === operation, 'PROVIDER_OPERATION_MISMATCH', 'Package provider plan operation mismatch');
    return clone(result);
  }

  async execute(operation, manifest, authorizationContext = {}) {
    const providerId = validateManifest(manifest);
    const adapter = this.#requireAdapter(providerId);
    const planned = this.plan(operation, manifest);
    const result = await adapter.execute(validateOperation(operation), clone(manifest), clone(authorizationContext));
    assert(result && typeof result === 'object', 'INVALID_PROVIDER_RESULT', 'Package provider returned an invalid execution result');
    return Object.freeze({
      schema: 'swir.system-package-provider-result/0.1',
      provider: providerId,
      operation,
      plan: planned,
      result: clone(result)
    });
  }

  async recoverPending(providerId, authorizationContext = {}) {
    assert(Object.prototype.hasOwnProperty.call(LINUX_PROVIDERS, providerId), 'UNSUPPORTED_PROVIDER', 'Unsupported Linux package provider');
    const adapter = this.#requireAdapter(providerId);
    assert(typeof adapter.recoverPending === 'function', 'RECOVERY_UNAVAILABLE', 'Selected package provider does not expose recovery');
    return clone(await adapter.recoverPending(clone(authorizationContext)));
  }

  #requireAdapter(providerId) {
    const adapter = this.#adapters.get(providerId);
    assert(adapter, 'PROVIDER_NOT_PROVISIONED', `${providerId} is recognized but not provisioned on this System Edition build`);
    return adapter;
  }
}

export function createSystemPackageProviderLayer({ distributionStack } = {}) {
  // Production composition intentionally provisions only the reviewed distribution stack today.
  // Future Flatpak/AppImage support must add reviewed adapters here rather than accepting arbitrary caller injection.
  const adapter = new DistributionPackageStackAdapter(distributionStack);
  return new SystemPackageProviderLayer({ adapters: new Map([['swir.package.system', adapter]]) });
}

export const SystemPackageProviderLayerPolicy = Object.freeze({
  schema: 'swir.system-package-provider-layer/0.1',
  manifestSchema: 'swir.package-provider/0.2',
  executionClass: 'linux-native',
  knownProviders: Object.keys(LINUX_PROVIDERS),
  provisionedByProductionFactory: ['swir.package.system'],
  plannedProviders: ['swir.package.flatpak', 'swir.package.appimage'],
  arbitraryProviderRegistration: false,
  directCommandExecution: false,
  privilegedMutationDelegated: true
});
