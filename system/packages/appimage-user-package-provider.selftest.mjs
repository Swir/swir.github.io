import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppImageUserPackageAdapter, buildAppImageUserPlan, validateAppImageManifest } from './appimage-user-package-provider.mjs';

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'swir-appimage-'));
const installRoot = path.join(root, 'installed');
const target = path.join(installRoot, 'org.example.tool.AppImage');
const artifact1 = path.join(root, 'tool-v1.AppImage');
const artifact2 = path.join(root, 'tool-v2.AppImage');
await fs.promises.writeFile(artifact1, '#!/bin/sh\necho v1\n');
await fs.promises.writeFile(artifact2, '#!/bin/sh\necho v2\n');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const manifest = sha256 => ({
  schema: 'swir.package-provider/0.2', id: 'org.example.tool', targetEditions: ['system'], executionClass: 'linux-native', provider: 'swir.package.appimage',
  package: { name: 'Tool', sourceRef: 'tool.AppImage', nativeEntryPoint: target, scope: 'user', sha256 },
  trust: { sourceClass: 'swir-signed', repositoryId: 'swir-appimage-catalog', signatureRequired: true }
});

validateAppImageManifest(manifest(digest(artifact1)), { installRoot });
const plan = buildAppImageUserPlan('install', manifest(digest(artifact1)), { installRoot });
assert.equal(plan.provider, 'swir.package.appimage');
assert.equal(plan.transaction.rollback.supported, true);
assert.equal(plan.sandbox.formatProvidesSandbox, false);
assert.equal(plan.trust.arbitraryDownloadUrlAllowed, false);

const adapter = new AppImageUserPackageAdapter({ installRoot });
await assert.rejects(() => adapter.execute('install', manifest(digest(artifact1)), { artifactPath: artifact1 }), error => error?.code === 'SIGNATURE_NOT_VERIFIED');
const installed = await adapter.execute('install', manifest(digest(artifact1)), { artifactPath: artifact1, signatureVerified: true });
assert.equal(installed.state, 'committed');
assert.equal(await fs.promises.readFile(target, 'utf8'), '#!/bin/sh\necho v1\n');
assert.equal((await fs.promises.stat(target)).mode & 0o777, 0o700);

await assert.rejects(() => adapter.execute('update', manifest('0'.repeat(64)), { artifactPath: artifact2, signatureVerified: true }), error => error?.code === 'DIGEST_MISMATCH');
assert.equal(await fs.promises.readFile(target, 'utf8'), '#!/bin/sh\necho v1\n');

const updated = await adapter.execute('update', manifest(digest(artifact2)), { artifactPath: artifact2, signatureVerified: true });
assert.equal(updated.rollbackAvailable, true);
assert.equal(await fs.promises.readFile(target, 'utf8'), '#!/bin/sh\necho v2\n');

const removed = await adapter.execute('remove', manifest(digest(artifact2)), { signatureVerified: true });
assert.equal(removed.state, 'committed');
assert.equal(await fs.promises.stat(target).then(() => true, () => false), false);
assert.deepEqual(await adapter.recoverPending(), []);

assert.throws(() => validateAppImageManifest({ ...manifest(digest(artifact1)), package: { ...manifest(digest(artifact1)).package, sourceRef: 'https://evil.invalid/a.AppImage' } }, { installRoot }), error => error?.code === 'INVALID_SOURCE_REF');
assert.throws(() => validateAppImageManifest({ ...manifest(digest(artifact1)), trust: { sourceClass: 'local-user-selected', signatureRequired: false } }, { installRoot }), error => error?.code === 'WRONG_SOURCE_CLASS');
assert.throws(() => validateAppImageManifest({ ...manifest(digest(artifact1)), package: { ...manifest(digest(artifact1)).package, nativeEntryPoint: '/tmp/escape.AppImage' } }, { installRoot }), error => error?.code === 'ENTRY_POINT_MISMATCH');

await fs.promises.rm(root, { recursive: true, force: true });
console.log('AppImage user package provider self-test: OK');
