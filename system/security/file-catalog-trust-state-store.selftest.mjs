import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileCatalogTrustStateStore } from './file-catalog-trust-state-store.mjs';
import { SystemCatalogTrustInternals, SystemCatalogTrustVerifier } from './system-catalog-authorization.mjs';

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'swir-catalog-state-'));
const stateRoot = path.join(root, 'state');
await fs.promises.mkdir(stateRoot, { mode: 0o700 });
const expectedOwnerUid = typeof process.getuid === 'function' ? process.getuid() : null;

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const jwk = publicKey.export({ format: 'jwk' });
const rawPublic = Buffer.from(String(jwk.x).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(jwk.x).length / 4) * 4, '='), 'base64');
const trustRoots = {
  schema: 'swir.catalog-trust-roots/1.0',
  requireSignedCatalog: true,
  roots: [{ keyId: 'test-system-root', algorithm: 'Ed25519', format: 'raw', publicKey: rawPublic.toString('base64'), scope: ['catalog:official'], enabled: true }]
};
const now = Date.parse('2026-09-17T00:30:00Z');

function release(sequence, version, digestChar = null) {
  const sourceRef = `tool-${version}.AppImage`;
  const sha256 = digestChar ? digestChar.repeat(64) : crypto.createHash('sha256').update(`artifact:${version}`).digest('hex');
  const manifest = {
    schema: 'swir.package-provider/0.2', id: 'org.example.tool', targetEditions: ['system'], executionClass: 'linux-native', provider: 'swir.package.appimage',
    package: { name: 'Tool', version, sourceRef, nativeEntryPoint: '/opt/swir/apps/org.example.tool.AppImage', scope: 'user', sha256 },
    trust: { sourceClass: 'swir-signed', repositoryId: 'official', signatureRequired: true }
  };
  const catalog = [{ packageId: manifest.id, version, artifacts: { system: { appimage: { provider: 'swir.package.appimage', sourceRef, sha256 } } } }];
  const envelope = {
    schema: 'swir.catalog-signature/1.0', catalogId: 'official', catalogVersion: `2026.09.17.${sequence}`, sequence,
    catalogSha256: SystemCatalogTrustInternals.fingerprintCatalog(catalog), generatedAt: '2026-09-17T00:00:00Z', expiresAt: '2026-09-17T03:00:00Z',
    algorithm: 'Ed25519', keyId: 'test-system-root'
  };
  envelope.signature = crypto.sign(null, Buffer.from(SystemCatalogTrustInternals.signedPayload(envelope)), privateKey).toString('base64');
  return { manifest, catalog, envelope };
}

const store = new FileCatalogTrustStateStore({ stateRoot, expectedOwnerUid });
assert.equal(store.describe().concurrentRollbackResistant, true);
assert.equal(await store.read(), null);

const r7 = release(7, '1.0.0');
const verifier1 = new SystemCatalogTrustVerifier({ trustRoots, stateStore: store });
const auth7 = await verifier1.authorizeAppImage(r7.manifest, { catalog: r7.catalog, envelope: r7.envelope, now });
assert.equal(auth7.sequence, 7);
assert.equal((await store.read()).sequence, 7);
const files7 = await fs.promises.readdir(stateRoot);
assert.equal(files7.length, 1);
assert.equal((await fs.promises.stat(path.join(stateRoot, files7[0]))).mode & 0o777, 0o600);

// A brand-new verifier process-equivalent must still enforce the persisted high-water mark.
const restartedStore = new FileCatalogTrustStateStore({ stateRoot, expectedOwnerUid });
const restartedVerifier = new SystemCatalogTrustVerifier({ trustRoots, stateStore: restartedStore });
const r6 = release(6, '0.9.0');
await assert.rejects(() => restartedVerifier.authorizeAppImage(r6.manifest, { catalog: r6.catalog, envelope: r6.envelope, now }), error => error?.code === 'ROLLBACK_DETECTED');

const r8 = release(8, '2.0.0');
await restartedVerifier.authorizeAppImage(r8.manifest, { catalog: r8.catalog, envelope: r8.envelope, now });
assert.equal((await restartedStore.read()).sequence, 8);
assert.equal((await fs.promises.readdir(stateRoot)).length, 2);

// Store-level rollback and same-sequence metadata replacement fail closed independently of the verifier.
const state8 = await restartedStore.read();
await assert.rejects(() => restartedStore.accept({ ...state8, sequence: 7 }), error => error?.code === 'STATE_ROLLBACK_DETECTED');
await assert.rejects(() => restartedStore.accept({ ...state8, keyId: 'different-root' }), error => error?.code === 'STATE_EQUIVOCATION_DETECTED');

// A forged competing file at the current high-water sequence forces a fail-closed read.
const forgedDigest = 'f'.repeat(64);
const forged = { ...state8, catalogSha256: forgedDigest };
const forgedName = `seq-${String(state8.sequence).padStart(16, '0')}-${forgedDigest}.json`;
await fs.promises.writeFile(path.join(stateRoot, forgedName), `${JSON.stringify(forged)}\n`, { mode: 0o600 });
await assert.rejects(() => restartedStore.read(), error => error?.code === 'STATE_EQUIVOCATION_DETECTED');
await fs.promises.rm(path.join(stateRoot, forgedName));
assert.equal((await restartedStore.read()).sequence, 8);

// State roots that can be modified by other users are rejected.
await fs.promises.chmod(stateRoot, 0o777);
await assert.rejects(() => restartedStore.read(), error => error?.code === 'UNSAFE_STATE_ROOT_MODE');
await fs.promises.chmod(stateRoot, 0o700);

// Symlinked roots are rejected even if the target itself is secure.
const linkRoot = path.join(root, 'state-link');
await fs.promises.symlink(stateRoot, linkRoot, 'dir');
const linkedStore = new FileCatalogTrustStateStore({ stateRoot: linkRoot, expectedOwnerUid });
await assert.rejects(() => linkedStore.read(), error => error?.code === 'UNSAFE_STATE_ROOT');

await fs.promises.rm(root, { recursive: true, force: true });
console.log('Persistent System catalog trust state self-test: OK');
