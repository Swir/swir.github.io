import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppImageUserPackageAdapter } from '../packages/appimage-user-package-provider.mjs';
import { NativePackageExecutionService } from '../runtime/native-package-execution-service.mjs';
import { MemoryCatalogTrustState, SystemCatalogTrustInternals, SystemCatalogTrustVerifier } from '../security/system-catalog-authorization.mjs';

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'swir-appimage-e2e-'));
const installRoot = path.join(root, 'apps');
const artifact = path.join(root, 'hello.AppImage');
const marker = path.join(root, 'launched.txt');
const target = path.join(installRoot, 'org.swir.hello.AppImage');
await fs.promises.writeFile(artifact, `#!/bin/sh\nprintf 'SWIR_NATIVE_OK' > "${marker}"\n`);
const sha256 = crypto.createHash('sha256').update(await fs.promises.readFile(artifact)).digest('hex');
const manifest = {
  schema: 'swir.package-provider/0.2',
  id: 'org.swir.hello',
  targetEditions: ['system'],
  executionClass: 'linux-native',
  provider: 'swir.package.appimage',
  package: { name: 'SWIR Hello', version: '1.0.0', sourceRef: 'hello-1.0.0.AppImage', nativeEntryPoint: target, scope: 'user', sha256 },
  trust: { sourceClass: 'swir-signed', repositoryId: 'official', signatureRequired: true }
};

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const jwk = publicKey.export({ format: 'jwk' });
const rawPublic = Buffer.from(String(jwk.x).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(jwk.x).length / 4) * 4, '='));
const trustVerifier = new SystemCatalogTrustVerifier({
  trustRoots: { schema: 'swir.catalog-trust-roots/1.0', requireSignedCatalog: true, roots: [{ keyId: 'e2e-system-catalog', algorithm: 'Ed25519', format: 'raw', publicKey: rawPublic.toString('base64'), scope: ['catalog:official'], enabled: true }] },
  stateStore: new MemoryCatalogTrustState()
});
const catalog = [{ packageId: manifest.id, version: manifest.package.version, artifacts: { system: { appimage: { provider: manifest.provider, sourceRef: manifest.package.sourceRef, sha256 } } } }];
const envelope = { schema: 'swir.catalog-signature/1.0', catalogId: 'official', catalogVersion: '2026.09.17.e2e', sequence: 1, generatedAt: '2026-09-16T23:55:00Z', expiresAt: '2026-09-17T02:00:00Z', algorithm: 'Ed25519', keyId: 'e2e-system-catalog', catalogSha256: SystemCatalogTrustInternals.fingerprintCatalog(catalog) };
envelope.signature = crypto.sign(null, Buffer.from(SystemCatalogTrustInternals.signedPayload(envelope)), privateKey).toString('base64');

const adapter = new AppImageUserPackageAdapter({ installRoot, trustVerifier });
await adapter.execute('install', manifest, { artifactPath: artifact, catalog, envelope, now: Date.parse('2026-09-17T00:00:00Z') });
const service = new NativePackageExecutionService();
const exited = new Promise((resolve, reject) => {
  service.once('exited', resolve);
  service.once('processError', ({ error }) => reject(error));
});
const launched = service.launch(manifest, { trustVerified: true, allowedRoots: [installRoot], stdio: 'ignore' });
assert.equal(launched.state, 'running');
const result = await exited;
assert.equal(result.exitCode, 0);
assert.equal(await fs.promises.readFile(marker, 'utf8'), 'SWIR_NATIVE_OK');
await fs.promises.rm(root, { recursive: true, force: true });
console.log('Signed catalog -> AppImage install -> native execution integration self-test: OK');
