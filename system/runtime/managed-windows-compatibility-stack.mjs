import path from 'node:path';
import { WindowsCompatibilityService } from './windows-compatibility-service.mjs';
import {
  WindowsCompatibilityRuntimeRegistry,
  WindowsCompatibilityRuntimeRegistryPolicy
} from './windows-compat-runtime-registry.mjs';

const DEFAULT_PREFIX_ROOT = '/var/lib/swir/compat/prefixes';

function fail(code, message) {
  const error = new Error(message);
  error.name = 'ManagedWindowsCompatibilityStackError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

export class ManagedWindowsCompatibilityStack {
  #registry;
  #service;
  #inventory;

  constructor({ registry, prefixRoot = DEFAULT_PREFIX_ROOT } = {}) {
    assert(registry && typeof registry.discover === 'function' && typeof registry.serviceOptions === 'function', 'INVALID_RUNTIME_REGISTRY', 'Trusted compatibility runtime registry is required');
    assert(typeof prefixRoot === 'string' && path.isAbsolute(prefixRoot), 'INVALID_PREFIX_ROOT', 'Compatibility prefix root must be absolute');
    this.#registry = registry;
    this.#inventory = registry.discover();
    const options = registry.serviceOptions();
    this.#service = new WindowsCompatibilityService({ prefixRoot, runtimePaths: { ...options.runtimePaths }, runtimeRoots: [...options.runtimeRoots] });
  }

  describe() {
    return Object.freeze({
      schema: 'swir.managed-windows-compatibility/0.1',
      inventorySchema: this.#inventory.schema,
      runtimeCount: this.#inventory.runtimes.length,
      healthyRuntimeCount: this.#inventory.runtimes.filter(runtime => runtime.healthy).length,
      providers: Object.freeze({
        wine: this.#inventory.runtimes.some(runtime => runtime.provider === 'swir.compat.wine' && runtime.healthy),
        proton: this.#inventory.runtimes.some(runtime => runtime.provider === 'swir.compat.proton' && runtime.healthy)
      }),
      prefixPolicy: 'per-app',
      arbitraryRuntimeDownloadAllowed: false,
      runtimeRootOwnershipRequired: this.#inventory.rootOwnershipRequired
    });
  }

  inventory() {
    return this.#inventory;
  }

  prepare(manifest, options = {}) { return this.#service.prepare(manifest, options); }
  plan(manifest, options = {}) { return this.#service.plan(manifest, options); }
  launch(manifest, options = {}) { return this.#service.launch(manifest, options); }
  list() { return this.#service.list(); }
  get(appId) { return this.#service.get(appId); }
  stop(appId, options = {}) { return this.#service.stop(appId, options); }
  forget(appId) { return this.#service.forget(appId); }
}

export function createManagedWindowsCompatibilityStack({
  prefixRoot = DEFAULT_PREFIX_ROOT,
  runtimeRoots = WindowsCompatibilityRuntimeRegistryPolicy.defaultRuntimeRoots,
  probeTimeoutMs = 3000
} = {}) {
  // Production composition is fail-closed: discovered runtimes must be root-owned,
  // executable, non-group/world-writable, under approved roots and version-probe clean.
  const registry = new WindowsCompatibilityRuntimeRegistry({
    runtimeRoots,
    probeTimeoutMs,
    requireRootOwned: true
  });
  return new ManagedWindowsCompatibilityStack({ registry, prefixRoot });
}

export const ManagedWindowsCompatibilityPolicy = Object.freeze({
  schema: 'swir.managed-windows-compatibility/0.1',
  runtimeInventory: 'swir.compat-runtime-inventory/0.1',
  runtimeRootOwnershipRequired: true,
  arbitraryRuntimeDownloadAllowed: false,
  directWindowsKernelDriverSupport: false,
  prefixPolicy: 'per-app',
  service: 'WindowsCompatibilityService'
});
