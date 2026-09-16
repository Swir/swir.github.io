import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppImageUserPackageAdapter, ManagedAppImageUserExecutor, buildAppImageUserPlan, validateAppImageManifest } from './appimage-user-package-provider.mjs';
import { MemoryCatalogTrustState, SystemCatalogTrustInternals, SystemCatalogTrustVerifier } from '../security/system-catalog-authorization.mjs';

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'swir-appimage-'));
const installRoot = path.join(root, 'installed');
const target = path.join(installRoot, 'org.example.tool.AppImage');
const artifact1 = path.join(root, 'tool-v1.AppImage');
const artifact2 = path.join(root, 'tool-v2.AppImage');
await fs.promises.writeFile(artifact1, '#!/bin/sh\necho v1\n');
await fs.promises.writeFile(artifact2, '#!/bin/sh\necho v2\n');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const verificationNow = Date.parse('2026-09-17T00:00:00Z');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const jwk = publicKey.export({ format: 'jwk' });
const rawPublic = Buffer.from(String(jwk.x).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(jwk.x).length / 4) * 4, '='));
const trustRoots = {
  schema: 'swir.catalog-trust-roots/1.0',
  requireSignedCatalog: true,
  roots: [{ keyId: 'test-system-catalog', name: 'CI System catalog root', algorithm: 'Ed25519', format: 'raw', publicKey: rawPublic.toString('base64'), scope: ['catalog:official'], enabled: true }]
};
const stateStore = new MemoryCatalogTrustState();
const verifier = new SystemCatalogTrustVerifier({ trustRoots, stateStore });

function manifest(version, sha256, sourceRef = `tool-${version}.AppImage`) {
  return {
    schema: 'swir.package-provider/0.2', id: 'org.example.tool', targetEditions: ['system'], executionClass: 'linux-native', provider: 'swir.package.appimage',
    package: { name: 'Tool', version, sourceRef, nativeEntryPoint: target, scope: 'user', sha256 },
    trust: { sourceClass: 'swir-signed', repositoryId: 'official', signatureRequired: true }
  };
}

function signedCatalog({ version, sourceRef, sha256, sequence, catalogVersion }) {
  const catalog = [{ packageId: 'org.example.tool', version, artifacts: { system: { appimage: { provider: 'swir.package.appimage', sourceRef, sha256 } } } }];
  const envelope = {
    schema: 'swir.catalog-signature/1.0', catalogId: 'official', catalogVersion, sequence,
    generatedAt: '2026-09-16T23:55:00Z', expiresAt: '2026-09-17T02:00:00Z', algorithm: 'Ed25519', keyId: 'test-system-catalog',
    catalogSha256: SystemCatalogTrustInternals.fingerprintCatalog(catalog)
  };
  envelope.signature = crypto.sign(null, Buffer.from(SystemCatalogTrustInternals.signedPayload(envelope)), privateKey).toString('base64');
  return { catalog, envelope };
}

const manifest1 = manifest('1.0.0', digest(artifact1));
const release1 = signedCatalog({ version: '1.0.0', sourceRef: manifest1.package.sourceRef, sha256: manifest1.package.sha256, sequence: 1, catalogVersion: '2026.09.17.1' });
validateAppImageManifest(manifest1, { installRoot });
const plan = buildAppImageUserPlan('install', manifest1, { installRoot });
assert.equal(plan.provider, 'swir.package.appimage');
assert.equal(plan.transaction.rollback.supported, false);
assert.equal(plan.transaction.rollback.crashRecoveryImplemented, true);
assert.equal(plan.sandbox.formatProvidesSandbox, false);
assert.equal(plan.trust.arbitraryDownloadUrlAllowed, false);
assert.equal(plan.trust.cryptographicCatalogAuthorizationRequired, true);

assert.throws(() => new AppImageUserPackageAdapter({ installRoot }), error => error?.code === 'TRUST_VERIFIER_REQUIRED');
const adapter = new AppImageUserPackageAdapter({ installRoot, trustVerifier: verifier });
await assert.rejects(() => adapter.execute('install', manifest1, { artifactPath: artifact1 }), error => error?.code === 'INVALID_ENVELOPE');

const forgedExecutor = new ManagedAppImageUserExecutor({ installRoot });
await assert.rejects(() => forgedExecutor.execute(plan, { artifactPath: artifact1, authorization: { schema: 'swir.system-catalog-authorization/0.1', provider: 'swir.package.appimage', packageId: manifest1.id, version: manifest1.package.version, sourceRef: manifest1.package.sourceRef, sha256: manifest1.package.sha256 } }), error => error?.code === 'CATALOG_AUTHORIZATION_NOT_VERIFIED');

const installed = await adapter.execute('install', manifest1, { artifactPath: artifact1, ...release1, now: verificationNow });
assert.equal(installed.state, 'committed');
assert.equal(installed.rollbackAvailable, false);
assert.equal(installed.recoveryBackupAvailable, false);
assert.equal(await fs.promises.readFile(target, 'utf8'), '#!/bin/sh\necho v1\n');
assert.equal((await fs.promises.stat(target)).mode & 0o777, 0o700);

const manifest2 = manifest('2.0.0', digest(artifact2));
const release2 = signedCatalog({ version: '2.0.0', sourceRef: manifest2.package.sourceRef, sha256: manifest2.package.sha256, sequence: 2, catalogVersion: '2026.09.17.2' });
const tamperedManifest = manifest('2.0.0', '0'.repeat(64));
await assert.rejects(() => adapter.execute('update', tamperedManifest, { artifactPath: artifact2, ...release2, now: verificationNow }), error => error?.code === 'PACKAGE_DIGEST_MISMATCH');
assert.equal(await fs.promises.readFile(target, 'utf8'), '#!/bin/sh\necho v1\n');

const updated = await adapter.execute('update', manifest2, { artifactPath: artifact2, ...release2, now: verificationNow });
assert.equal(updated.rollbackAvailable, false);
assert.equal(updated.recoveryBackupAvailable, true);
assert.equal(await fs.promises.readFile(target, 'utf8'), '#!/bin/sh\necho v2\n');
await assert.rejects(() => verifier.authorizeAppImage(manifest1, { ...release1, now: verificationNow }), error => error?.code === 'ROLLBACK_DETECTED');

const tamperedCatalog = structuredClone(release2.catalog);
tamperedCatalog[0].artifacts.system.appimage.sha256 = 'f'.repeat(64);
await assert.rejects(() => verifier.authorizeAppImage(manifest2, { catalog: tamperedCatalog, envelope: release2.envelope, now: verificationNow }), error => error?.code === 'CATALOG_MISMATCH');

const removed = await adapter.execute('remove', manifest2);
assert.equal(removed.state, 'committed');
assert.equal(await fs.promises.stat(target).then(() => true, () => false), false);
assert.deepEqual(await adapter.recoverPending(), []);

assert.throws(() => validateAppImageManifest({ ...manifest1, package: { ...manifest1.package, sourceRef: 'https://evil.invalid/a.AppImage' } }, { installRoot }), error => error?.code === 'INVALID_SOURCE_REF');
assert.throws(() => validateAppImageManifest({ ...manifest1, trust: { sourceClass: 'local-user-selected', repositoryId: 'official', signatureRequired: false } }, { installRoot }), error => error?.code === 'WRONG_SOURCE_CLASS');
assert.throws(() => validateAppImageManifest({ ...manifest1, package: { ...manifest1.package, nativeEntryPoint: '/tmp/escape.AppImage' } }, { installRoot }), error => error?.code === 'ENTRY_POINT_MISMATCH');

const journalRoot = path.join(installRoot, '.transactions');
await fs.promises.mkdir(journalRoot, { recursive: true, mode: 0o700 });
await fs.promises.writeFile(path.join(journalRoot, 'evil.json'), JSON.stringify({ schema: 'swir.appimage-transaction/0.1', id: 'evil', packageId: 'org.example.tool', operation: 'install', target: '/tmp/evil.AppImage', backup: null, temp: null, state: 'prepared' }));
await assert.rejects(() => adapter.recoverPending(), error => error?.code === 'INVALID_JOURNAL_TARGET');

await fs.promises.rm(root, { recursive: true, force: true });
console.log('AppImage user package provider self-test: OK');
