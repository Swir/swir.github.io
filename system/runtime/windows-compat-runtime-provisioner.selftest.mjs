import assert from 'node:assert/strict';
import {
  WindowsCompatibilityRuntimeProvisioner,
  WindowsCompatibilityRuntimeProvisionerPolicy,
  validateCompatibilityRuntimeProvisioningCatalog
} from './windows-compat-runtime-provisioner.mjs';

const wineManifest = {
  schema: 'swir.package-provider/0.2',
  id: 'swir.runtime.wine',
  targetEditions: ['system'],
  executionClass: 'linux-native',
  provider: 'swir.package.system',
  package: { name: 'Wine runtime', sourceRef: 'wine', nativeEntryPoint: '/usr/bin/wine' },
  trust: { sourceClass: 'distribution-repository', repositoryId: 'distro-main', signatureRequired: true }
};
const protonManifest = {
  ...wineManifest,
  id: 'swir.runtime.proton',
  package: { name: 'Proton runtime', sourceRef: 'proton', nativeEntryPoint: '/usr/bin/proton' }
};
const catalog = {
  schema: 'swir.compat-runtime-provisioning-catalog/0.1',
  entries: [
    { runtimeProvider: 'swir.compat.wine', packageManifest: wineManifest, channel: 'distribution' },
    { runtimeProvider: 'swir.compat.proton', packageManifest: protonManifest, channel: 'distribution' }
  ]
};

assert.equal(validateCompatibilityRuntimeProvisioningCatalog(catalog).entries.length, 2);
assert.throws(() => validateCompatibilityRuntimeProvisioningCatalog({ ...catalog, entries: [...catalog.entries, catalog.entries[0]] }), error => error?.code === 'DUPLICATE_RUNTIME_PROVIDER');
assert.throws(() => validateCompatibilityRuntimeProvisioningCatalog({ ...catalog, entries: [{ ...catalog.entries[0], downloadUrl: 'https://example.invalid/wine' }] }), error => error?.code === 'UNTRUSTED_RUNTIME_SOURCE');
assert.throws(() => validateCompatibilityRuntimeProvisioningCatalog({ ...catalog, entries: [{ ...catalog.entries[0], packageManifest: { ...wineManifest, trust: { ...wineManifest.trust, signatureRequired: false } } }] }), error => error?.code === 'SIGNATURE_REQUIRED');

const calls = [];
const packageLayer = {
  plan(operation, manifest) {
    calls.push(['plan', operation, manifest.id]);
    return { schema: 'swir.system-package-plan/0.1', provider: manifest.provider, operation, package: { id: manifest.id } };
  },
  async execute(operation, manifest, auth) {
    calls.push(['execute', operation, manifest.id, auth.subject || null]);
    return { schema: 'swir.package-transaction-result/0.1', state: 'committed', operation };
  },
  async recoverPending(provider, auth) {
    calls.push(['recover', provider, auth.subject || null]);
    return [{ id: 'txn-1', state: 'recovered' }];
  }
};

const inventories = [
  { schema: 'swir.compat-runtime-inventory/0.1', runtimes: [], rootOwnershipRequired: true },
  { schema: 'swir.compat-runtime-inventory/0.1', runtimes: [{ id: 'wine:verified', provider: 'swir.compat.wine', healthy: true, path: '/usr/bin/wine', version: 'wine-10.0' }], rootOwnershipRequired: true }
];
let inventoryIndex = 0;
const registryFactory = () => ({ discover: () => inventories[Math.min(inventoryIndex++, inventories.length - 1)] });
const provisioner = new WindowsCompatibilityRuntimeProvisioner({ packageLayer, registryFactory, catalog });

const description = provisioner.describe();
assert.equal(description.arbitraryDownloads, false);
assert.equal(description.directPackageManagerExecution, false);
assert.deepEqual(description.providers, ['swir.compat.wine', 'swir.compat.proton']);

const plan = provisioner.plan('swir.compat.wine', 'install');
assert.equal(plan.runtimeProvider, 'swir.compat.wine');
assert.equal(plan.packagePlan.provider, 'swir.package.system');
assert.deepEqual(calls.shift(), ['plan', 'install', 'swir.runtime.wine']);

const result = await provisioner.provision('swir.compat.wine', 'install', { subject: 'session:1000' });
assert.equal(result.state, 'verified');
assert.equal(result.runtime.provider, 'swir.compat.wine');
assert.deepEqual(calls.shift(), ['plan', 'install', 'swir.runtime.wine']);
assert.deepEqual(calls.shift(), ['execute', 'install', 'swir.runtime.wine', 'session:1000']);

const alreadyInventory = { schema: 'swir.compat-runtime-inventory/0.1', runtimes: [{ id: 'wine:present', provider: 'swir.compat.wine', healthy: true }], rootOwnershipRequired: true };
const already = new WindowsCompatibilityRuntimeProvisioner({ packageLayer, registryFactory: () => ({ discover: () => alreadyInventory }), catalog });
const alreadyResult = await already.provision('swir.compat.wine', 'install', { subject: 'session:1000' });
assert.equal(alreadyResult.state, 'already-present');

const missing = new WindowsCompatibilityRuntimeProvisioner({
  packageLayer,
  registryFactory: () => ({ discover: () => ({ schema: 'swir.compat-runtime-inventory/0.1', runtimes: [], rootOwnershipRequired: true }) }),
  catalog
});
await assert.rejects(() => missing.provision('swir.compat.proton', 'update', { subject: 'session:1000' }), error => error?.code === 'RUNTIME_VERIFICATION_FAILED' && error?.details?.recoveryRequired === true);
assert.deepEqual(calls.shift(), ['plan', 'update', 'swir.runtime.proton']);
assert.deepEqual(calls.shift(), ['execute', 'update', 'swir.runtime.proton', 'session:1000']);

const recovered = await provisioner.recoverPending({ subject: 'session:1000' });
assert.equal(recovered[0].state, 'recovered');
assert.deepEqual(calls.shift(), ['recover', 'swir.package.system', 'session:1000']);
assert.equal(calls.length, 0);

assert.equal(WindowsCompatibilityRuntimeProvisionerPolicy.arbitraryDownloads, false);
assert.equal(WindowsCompatibilityRuntimeProvisionerPolicy.trustedRuntimeRediscoveryRequired, true);
assert.deepEqual(WindowsCompatibilityRuntimeProvisionerPolicy.supportedOperations.sort(), ['install', 'update']);

console.log('Windows compatibility runtime provisioner self-test: OK');
