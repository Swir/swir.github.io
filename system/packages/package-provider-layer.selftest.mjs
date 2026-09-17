import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DistributionPackageStackAdapter,
  SystemPackageProviderLayer,
  SystemPackageProviderLayerPolicy,
  createExperimentalSystemPackageProviderLayer,
  createSystemPackageProviderLayer
} from './package-provider-layer.mjs';
import { FlatpakUserPackageAdapter, GuardedFlatpakUserExecutor } from './flatpak-user-package-provider.mjs';
import { AppImageUserPackageAdapter } from './appimage-user-package-provider.mjs';
import { MemoryCatalogTrustState, SystemCatalogTrustInternals, SystemCatalogTrustVerifier } from '../security/system-catalog-authorization.mjs';

const manifest = {
  schema: 'swir.package-provider/0.2', id: 'org.example.editor', targetEditions: ['system'], executionClass: 'linux-native', provider: 'swir.package.system',
  package: { name: 'Example Editor', sourceRef: 'example-editor', nativeEntryPoint: '/usr/bin/example-editor' },
  trust: { sourceClass: 'distribution-repository', repositoryId: 'debian-main', signatureRequired: true }
};

const calls = [];
const stack = {
  describe() { return { schema: 'swir.system-package-stack/0.1', provider: 'distribution' }; },
  plan(operation, packageManifest) { calls.push(['plan', operation, packageManifest.id]); return { schema: 'swir.system-package-plan/0.1', provider: packageManifest.provider, executionClass: 'linux-native', operation, package: { id: packageManifest.id }, transaction: { requiresPrivilege: true } }; },
  async execute(operation, packageManifest, auth) { calls.push(['execute', operation, packageManifest.id, auth.subject || null]); return { schema: 'swir.package-transaction-result/0.1', state: 'committed', operation }; },
  async recoverPending(auth) { calls.push(['recover', auth.subject || null]); return [{ id: 'txn-1', state: 'recovered' }]; }
};

const layer = createSystemPackageProviderLayer({ distributionStack: stack });
const description = layer.describe();
assert.equal(description.schema, 'swir.system-package-provider-layer/0.1');
assert.equal(description.directCommandExecution, false);
assert.equal(description.arbitraryProviderRegistration, false);
assert.equal(description.providers.find(item => item.id === 'swir.package.system')?.state, 'ready');
assert.equal(description.providers.find(item => item.id === 'swir.package.flatpak')?.state, 'not-provisioned');
assert.equal(description.providers.find(item => item.id === 'swir.package.appimage')?.state, 'not-provisioned');
assert.equal(description.providers.find(item => item.id === 'swir.package.appimage')?.roadmapStatus, 'implemented');
assert.equal(description.providers.every(item => item.productionProvisionable === true), true);

const plan = layer.plan('install', manifest);
assert.equal(plan.provider, 'swir.package.system');
assert.deepEqual(calls.shift(), ['plan', 'install', 'org.example.editor']);
const executed = await layer.execute('update', manifest, { subject: 'session:1000' });
assert.equal(executed.result.state, 'committed');
assert.deepEqual(calls.shift(), ['plan', 'update', 'org.example.editor']);
assert.deepEqual(calls.shift(), ['execute', 'update', 'org.example.editor', 'session:1000']);
const recovered = await layer.recoverPending('swir.package.system', { subject: 'session:1000' });
assert.equal(recovered[0].state, 'recovered');
assert.deepEqual(calls.shift(), ['recover', 'session:1000']);

const flatpakManifest = {
  ...manifest, id: 'org.example.flateditor', provider: 'swir.package.flatpak',
  package: { name: 'Flat Editor', sourceRef: 'org.example.FlatEditor', nativeEntryPoint: 'org.example.FlatEditor', remote: 'flathub', scope: 'user' },
  trust: { sourceClass: 'flatpak-remote', repositoryId: 'flathub', signatureRequired: true }
};
assert.throws(() => layer.plan('install', flatpakManifest), error => error?.code === 'PROVIDER_NOT_PROVISIONED');
const flatpakCalls = [];
const flatpakExecutor = new GuardedFlatpakUserExecutor({
  allowlistedRemotes: ['flathub'],
  fileProbe: () => ({ isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100755, realpath: '/usr/bin/flatpak' }),
  runner(binary, args, options) {
    flatpakCalls.push([binary, args, options.shell]);
    if (args[0] === '--user' && args[1] === 'remotes') return { status: 0, stdout: 'flathub\tuser\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  }
});
const flatpakAdapter = new FlatpakUserPackageAdapter({ allowlistedRemotes: ['flathub'], executor: flatpakExecutor });
const mixed = new SystemPackageProviderLayer({ adapters: new Map([['swir.package.system', new DistributionPackageStackAdapter(stack)], ['swir.package.flatpak', flatpakAdapter]]) });
const flatpakResult = await mixed.execute('install', flatpakManifest, { subject: 'session:1000' });
assert.equal(flatpakResult.result.state, 'committed');
assert.equal(flatpakResult.result.runtimeTrust.gpgVerify, true);
assert.equal(flatpakCalls.length, 2);
assert.equal(flatpakCalls[0][0], '/usr/bin/flatpak');
assert.deepEqual(flatpakCalls[0][1], ['--user', 'remotes', '--columns=name,options']);
assert.equal(flatpakCalls[0][2], false);
assert.deepEqual(flatpakCalls[1][1], ['--user', '--noninteractive', 'install', '--or-update', 'flathub', 'org.example.FlatEditor']);

const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'swir-provider-layer-'));
const appImageInstallRoot = path.join(tempRoot, 'appimages');
const artifact = path.join(tempRoot, 'viewer.AppImage');
await fs.promises.writeFile(artifact, '#!/bin/sh\nexit 0\n');
const sha256 = crypto.createHash('sha256').update(await fs.promises.readFile(artifact)).digest('hex');
const appImageManifest = {
  ...manifest, id: 'org.example.viewer', provider: 'swir.package.appimage',
  package: { name: 'Viewer', version: '1.0.0', sourceRef: 'viewer-1.0.0.AppImage', nativeEntryPoint: path.join(appImageInstallRoot, 'org.example.viewer.AppImage'), scope: 'user', sha256 },
  trust: { sourceClass: 'swir-signed', repositoryId: 'official', signatureRequired: true }
};
assert.throws(() => layer.plan('install', appImageManifest), error => error?.code === 'PROVIDER_NOT_PROVISIONED');
assert.throws(() => createSystemPackageProviderLayer({ distributionStack: stack, appImageInstallRoot }), error => error?.code === 'INVALID_APPIMAGE_COMPOSITION');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const jwk = publicKey.export({ format: 'jwk' });
const raw = Buffer.from(String(jwk.x).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(jwk.x).length / 4) * 4, '='), 'base64');
const trustVerifier = new SystemCatalogTrustVerifier({
  trustRoots: { schema: 'swir.catalog-trust-roots/1.0', requireSignedCatalog: true, roots: [{ keyId: 'layer-test', algorithm: 'Ed25519', format: 'raw', publicKey: raw.toString('base64'), scope: ['catalog:official'], enabled: true }] },
  stateStore: new MemoryCatalogTrustState()
});
const catalog = [{ packageId: appImageManifest.id, version: appImageManifest.package.version, artifacts: { system: { appimage: { provider: 'swir.package.appimage', sourceRef: appImageManifest.package.sourceRef, sha256 } } } }];
const envelope = { schema: 'swir.catalog-signature/1.0', catalogId: 'official', catalogVersion: '2026.09.17.layer', sequence: 1, generatedAt: '2026-09-16T23:55:00Z', expiresAt: '2026-09-17T02:00:00Z', algorithm: 'Ed25519', keyId: 'layer-test', catalogSha256: SystemCatalogTrustInternals.fingerprintCatalog(catalog) };
envelope.signature = crypto.sign(null, Buffer.from(SystemCatalogTrustInternals.signedPayload(envelope)), privateKey).toString('base64');

const productionLayer = createSystemPackageProviderLayer({ distributionStack: stack, flatpakAllowedRemotes: ['flathub'], appImageInstallRoot, appImageTrustVerifier: trustVerifier });
assert.equal(productionLayer.providerState('swir.package.system').state, 'ready');
assert.equal(productionLayer.providerState('swir.package.flatpak').state, 'ready');
assert.equal(productionLayer.providerState('swir.package.appimage').state, 'ready');
assert.equal(productionLayer.plan('install', flatpakManifest).provider, 'swir.package.flatpak');
assert.equal(productionLayer.plan('install', appImageManifest).provider, 'swir.package.appimage');
const appImageResult = await productionLayer.execute('install', appImageManifest, { artifactPath: artifact, catalog, envelope, now: Date.parse('2026-09-17T00:00:00Z') });
assert.equal(appImageResult.result.state, 'committed');
assert.equal(await fs.promises.stat(appImageManifest.package.nativeEntryPoint).then(s => s.isFile(), () => false), true);

const compatibilityAlias = createExperimentalSystemPackageProviderLayer({ distributionStack: stack, flatpakAllowedRemotes: ['flathub'], appImageInstallRoot, appImageTrustVerifier: trustVerifier });
assert.deepEqual(compatibilityAlias.describe().providers.map(item => [item.id, item.state]), productionLayer.describe().providers.map(item => [item.id, item.state]));
await fs.promises.rm(tempRoot, { recursive: true, force: true });

const windowsManifest = { ...manifest, executionClass: 'windows-compat', provider: 'swir.compat.wine' };
assert.throws(() => layer.plan('install', windowsManifest), error => error?.code === 'WRONG_EXECUTION_CLASS');
assert.throws(() => layer.plan('launch', manifest), error => error?.code === 'UNSUPPORTED_OPERATION');
const badAdapter = new Map([['swir.package.system', { plan() {}, execute() {} }]]);
const mismatchLayer = new SystemPackageProviderLayer({ adapters: badAdapter });
assert.throws(() => mismatchLayer.plan('install', manifest), error => error?.code === 'INVALID_PROVIDER_PLAN');

assert.throws(() => new AppImageUserPackageAdapter({ installRoot: '/tmp/swir-appimage-adapter-shape' }), error => error?.code === 'TRUST_VERIFIER_REQUIRED');
assert.deepEqual(SystemPackageProviderLayerPolicy.defaultProvisionedProviders, ['swir.package.system']);
assert.deepEqual(SystemPackageProviderLayerPolicy.productionProvisionableProviders, ['swir.package.system', 'swir.package.flatpak', 'swir.package.appimage']);
assert.deepEqual(SystemPackageProviderLayerPolicy.productionOptionalProviders, ['swir.package.flatpak', 'swir.package.appimage']);
assert.deepEqual(SystemPackageProviderLayerPolicy.experimentalProviders, []);
assert.deepEqual(SystemPackageProviderLayerPolicy.plannedProviders, []);
assert.equal(SystemPackageProviderLayerPolicy.flatpakRequiresAllowlistedPreconfiguredRemote, true);
assert.equal(SystemPackageProviderLayerPolicy.appImageRequiresNativeCatalogTrustVerifier, true);
assert.equal(SystemPackageProviderLayerPolicy.appImageRequiresManagedInstallRoot, true);

console.log('System Package Provider Layer production composition self-test: OK');