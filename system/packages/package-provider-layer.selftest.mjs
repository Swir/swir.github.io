import assert from 'node:assert/strict';
import {
  DistributionPackageStackAdapter,
  SystemPackageProviderLayer,
  SystemPackageProviderLayerPolicy,
  createExperimentalSystemPackageProviderLayer,
  createSystemPackageProviderLayer
} from './package-provider-layer.mjs';
import { FlatpakUserPackageAdapter, GuardedFlatpakUserExecutor } from './flatpak-user-package-provider.mjs';

const manifest = {
  schema: 'swir.package-provider/0.2',
  id: 'org.example.editor',
  targetEditions: ['system'],
  executionClass: 'linux-native',
  provider: 'swir.package.system',
  package: { name: 'Example Editor', sourceRef: 'example-editor', nativeEntryPoint: '/usr/bin/example-editor' },
  trust: { sourceClass: 'distribution-repository', repositoryId: 'debian-main', signatureRequired: true }
};

const calls = [];
const stack = {
  describe() { return { schema: 'swir.system-package-stack/0.1', provider: 'distribution' }; },
  plan(operation, packageManifest) {
    calls.push(['plan', operation, packageManifest.id]);
    return {
      schema: 'swir.system-package-plan/0.1',
      provider: packageManifest.provider,
      executionClass: 'linux-native',
      operation,
      package: { id: packageManifest.id },
      transaction: { requiresPrivilege: true }
    };
  },
  async execute(operation, packageManifest, auth) {
    calls.push(['execute', operation, packageManifest.id, auth.subject || null]);
    return { schema: 'swir.package-transaction-result/0.1', state: 'committed', operation };
  },
  async recoverPending(auth) {
    calls.push(['recover', auth.subject || null]);
    return [{ id: 'txn-1', state: 'recovered' }];
  }
};

const layer = createSystemPackageProviderLayer({ distributionStack: stack });
const description = layer.describe();
assert.equal(description.schema, 'swir.system-package-provider-layer/0.1');
assert.equal(description.directCommandExecution, false);
assert.equal(description.arbitraryProviderRegistration, false);
assert.equal(description.providers.find(item => item.id === 'swir.package.system')?.state, 'ready');
assert.equal(description.providers.find(item => item.id === 'swir.package.flatpak')?.state, 'not-provisioned');
assert.equal(description.providers.find(item => item.id === 'swir.package.flatpak')?.roadmapStatus, 'experimental');
assert.equal(description.providers.find(item => item.id === 'swir.package.appimage')?.state, 'not-provisioned');

const plan = layer.plan('install', manifest);
assert.equal(plan.provider, 'swir.package.system');
assert.equal(plan.operation, 'install');
assert.deepEqual(calls.shift(), ['plan', 'install', 'org.example.editor']);

const executed = await layer.execute('update', manifest, { subject: 'session:1000' });
assert.equal(executed.schema, 'swir.system-package-provider-result/0.1');
assert.equal(executed.provider, 'swir.package.system');
assert.equal(executed.operation, 'update');
assert.equal(executed.result.state, 'committed');
assert.deepEqual(calls.shift(), ['plan', 'update', 'org.example.editor']);
assert.deepEqual(calls.shift(), ['execute', 'update', 'org.example.editor', 'session:1000']);

const recovered = await layer.recoverPending('swir.package.system', { subject: 'session:1000' });
assert.equal(recovered[0].state, 'recovered');
assert.deepEqual(calls.shift(), ['recover', 'session:1000']);
assert.equal(calls.length, 0);

const flatpakManifest = {
  ...manifest,
  id: 'org.example.FlatEditor',
  provider: 'swir.package.flatpak',
  package: { name: 'Flat Editor', sourceRef: 'org.example.FlatEditor', nativeEntryPoint: 'org.example.FlatEditor', remote: 'flathub', scope: 'user' },
  trust: { sourceClass: 'flatpak-remote', repositoryId: 'flathub', signatureRequired: true }
};
assert.throws(() => layer.plan('install', flatpakManifest), error => error?.code === 'PROVIDER_NOT_PROVISIONED');

const previewLayer = createExperimentalSystemPackageProviderLayer({ distributionStack: stack, flatpakAllowedRemotes: ['flathub'] });
assert.equal(previewLayer.providerState('swir.package.flatpak').state, 'ready');
assert.equal(previewLayer.plan('install', flatpakManifest).provider, 'swir.package.flatpak');

const flatpakCalls = [];
const flatpakExecutor = new GuardedFlatpakUserExecutor({
  allowlistedRemotes: ['flathub'],
  runner(binary, args, options) {
    flatpakCalls.push([binary, args, options.shell]);
    return { status: 0, stdout: '', stderr: '' };
  }
});
const flatpakAdapter = new FlatpakUserPackageAdapter({ allowlistedRemotes: ['flathub'], executor: flatpakExecutor });
const mixed = new SystemPackageProviderLayer({
  adapters: new Map([
    ['swir.package.system', new DistributionPackageStackAdapter(stack)],
    ['swir.package.flatpak', flatpakAdapter]
  ])
});
const flatpakResult = await mixed.execute('install', flatpakManifest, { subject: 'session:1000' });
assert.equal(flatpakResult.provider, 'swir.package.flatpak');
assert.equal(flatpakResult.result.state, 'committed');
assert.equal(flatpakCalls.length, 1);
assert.equal(flatpakCalls[0][0], '/usr/bin/flatpak');
assert.equal(flatpakCalls[0][2], false);

const windowsManifest = {
  ...manifest,
  executionClass: 'windows-compat',
  provider: 'swir.compat.wine'
};
assert.throws(() => layer.plan('install', windowsManifest), error => error?.code === 'WRONG_EXECUTION_CLASS');
assert.throws(() => layer.plan('launch', manifest), error => error?.code === 'UNSUPPORTED_OPERATION');

const badAdapter = new Map([['swir.package.system', { plan() {}, execute() {} }]]);
const mismatchLayer = new SystemPackageProviderLayer({ adapters: badAdapter });
assert.throws(() => mismatchLayer.plan('install', manifest), error => error?.code === 'INVALID_PROVIDER_PLAN');

const adapter = new DistributionPackageStackAdapter(stack);
assert.equal(adapter.describe().provider, 'swir.package.system');
assert.deepEqual(SystemPackageProviderLayerPolicy.provisionedByProductionFactory, ['swir.package.system']);
assert.deepEqual(SystemPackageProviderLayerPolicy.experimentalProviders, ['swir.package.flatpak']);
assert.deepEqual(SystemPackageProviderLayerPolicy.plannedProviders, ['swir.package.appimage']);

console.log('System Package Provider Layer self-test: OK');
