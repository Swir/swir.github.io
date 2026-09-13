import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const SIGNATURE_SCHEMA = 'swir.catalog-signature/1.0';
const ROOT_SCHEMA = 'swir.catalog-trust-roots/1.0';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      if (value[key] !== undefined) out[key] = stable(value[key]);
      return out;
    }, {});
  }
  return value;
}
function canonicalize(value) { return JSON.stringify(stable(value)); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fail(message) { throw new Error(message); }
function rawPublicKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  let text = String(jwk.x || '').replace(/-/g, '+').replace(/_/g, '/');
  while (text.length % 4) text += '=';
  const raw = Buffer.from(text, 'base64');
  if (raw.length !== 32) fail(`Expected 32-byte Ed25519 public key, got ${raw.length}`);
  return raw;
}
function signedPayload(envelope) {
  return canonicalize({
    schema: SIGNATURE_SCHEMA,
    catalogId: String(envelope.catalogId),
    catalogVersion: String(envelope.catalogVersion),
    sequence: Number(envelope.sequence),
    catalogSha256: String(envelope.catalogSha256).toLowerCase(),
    generatedAt: String(envelope.generatedAt),
    expiresAt: String(envelope.expiresAt)
  });
}
function signCatalog(privateKey, keyId, sequence, version, catalog) {
  const now = new Date('2026-09-14T00:00:00.000Z');
  const envelope = {
    schema: SIGNATURE_SCHEMA,
    catalogId: 'official',
    catalogVersion: version,
    sequence,
    catalogSha256: sha256(canonicalize(catalog)),
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    algorithm: 'Ed25519',
    keyId,
    signature: ''
  };
  envelope.signature = crypto.sign(null, Buffer.from(signedPayload(envelope)), privateKey).toString('base64');
  return { catalog, envelope };
}
function makeRoot(keyId, publicKey, notBeforeSequence = 1, retireAfterSequence = undefined) {
  const root = {
    keyId,
    algorithm: 'Ed25519',
    format: 'raw',
    publicKey: rawPublicKey(publicKey).toString('base64'),
    scope: ['catalog:official'],
    enabled: true,
    notBeforeSequence
  };
  if (retireAfterSequence !== undefined) root.retireAfterSequence = retireAfterSequence;
  return root;
}
function verifyTrustPolicy(trust, expected) {
  if (trust?.schema !== ROOT_SCHEMA || trust.requireSignedCatalog !== true) fail('Trust policy must fail closed');
  const roots = Array.isArray(trust.roots) ? trust.roots : [];
  if (roots.length !== 2) fail(`Expected exactly two rotation roots, got ${roots.length}`);
  for (const item of expected) {
    const root = roots.find(candidate => candidate.keyId === item.keyId);
    if (!root) fail(`Missing expected root ${item.keyId}`);
    const actualFingerprint = sha256(Buffer.from(root.publicKey, 'base64'));
    if (actualFingerprint !== item.fingerprint) fail(`Fingerprint mismatch for ${item.keyId}`);
    if (root.notBeforeSequence !== item.notBeforeSequence) fail(`notBeforeSequence changed for ${item.keyId}`);
    if ((root.retireAfterSequence ?? null) !== (item.retireAfterSequence ?? null)) fail(`retireAfterSequence changed for ${item.keyId}`);
  }
}
class RestartableVerifier {
  constructor({ trust, statePath, expectedPolicy }) {
    this.trust = JSON.parse(JSON.stringify(trust));
    this.statePath = statePath;
    this.expectedPolicy = expectedPolicy;
    verifyTrustPolicy(this.trust, this.expectedPolicy);
    this.state = fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
      : { schema: 'swir.catalog-cutover-state/1.0', highWaterSequence: 0, acceptedKeyId: null };
  }
  verify(release) {
    verifyTrustPolicy(this.trust, this.expectedPolicy);
    const { catalog, envelope } = release;
    if (envelope?.schema !== SIGNATURE_SCHEMA || envelope.catalogId !== 'official' || envelope.algorithm !== 'Ed25519') fail('Envelope metadata invalid');
    const sequence = Number(envelope.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) fail('Envelope sequence invalid');
    const root = this.trust.roots.find(candidate => candidate.enabled !== false && candidate.keyId === envelope.keyId && candidate.scope?.includes('catalog:official'));
    if (!root) fail('CATALOG_KEY_UNKNOWN');
    if (sequence < Number(root.notBeforeSequence || 1)) fail('CATALOG_KEY_NOT_ACTIVE');
    if (root.retireAfterSequence !== undefined && sequence > Number(root.retireAfterSequence)) fail('CATALOG_KEY_RETIRED');
    if (sequence <= Number(this.state.highWaterSequence || 0)) fail('CATALOG_ROLLBACK_DETECTED');
    const digest = sha256(canonicalize(catalog));
    if (digest !== envelope.catalogSha256) fail('CATALOG_DIGEST_MISMATCH');
    const raw = Buffer.from(root.publicKey, 'base64');
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    const signature = Buffer.from(envelope.signature, 'base64');
    if (!crypto.verify(null, Buffer.from(signedPayload(envelope)), publicKey, signature)) fail('CATALOG_SIGNATURE_INVALID');
    this.state = { schema: 'swir.catalog-cutover-state/1.0', highWaterSequence: sequence, acceptedKeyId: envelope.keyId };
    fs.writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
    return this.state;
  }
}
function expectFailure(fn, code) {
  let matched = false;
  try { fn(); } catch (error) { matched = String(error?.message || error).includes(code); }
  if (!matched) fail(`Expected fail-closed error ${code}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-catalog-cutover-e2e-'));
try {
  const currentPair = crypto.generateKeyPairSync('ed25519');
  const nextPair = crypto.generateKeyPairSync('ed25519');
  const currentFingerprint = sha256(rawPublicKey(currentPair.publicKey));
  const nextFingerprint = sha256(rawPublicKey(nextPair.publicKey));
  const trust = {
    schema: ROOT_SCHEMA,
    requireSignedCatalog: true,
    roots: [
      makeRoot('catalog-current', currentPair.publicKey, 1, 1002),
      makeRoot('catalog-next', nextPair.publicKey, 1001)
    ]
  };
  const expectedPolicy = [
    { keyId: 'catalog-current', fingerprint: currentFingerprint, notBeforeSequence: 1, retireAfterSequence: 1002 },
    { keyId: 'catalog-next', fingerprint: nextFingerprint, notBeforeSequence: 1001 }
  ];
  const statePath = path.join(tmp, 'catalog-high-water.json');
  const catalog = [{ packageId: 'swir.cutover-test', version: '1.0.0', artifacts: { desktop: { url: 'packages/swir.cutover-test-1.0.0.swirapp', sha256: '11'.repeat(32) } } }];

  // Release A: current root before cutover.
  let verifier = new RestartableVerifier({ trust, statePath, expectedPolicy });
  verifier.verify(signCatalog(currentPair.privateKey, 'catalog-current', 1000, 'cutover-current', catalog));

  // Restart #1: next root must not be usable before its activation sequence.
  verifier = new RestartableVerifier({ trust, statePath, expectedPolicy });
  expectFailure(() => verifier.verify(signCatalog(nextPair.privateKey, 'catalog-next', 1000, 'next-too-early', catalog)), 'CATALOG_KEY_NOT_ACTIVE');
  verifier.verify(signCatalog(nextPair.privateKey, 'catalog-next', 1001, 'cutover-next', catalog));

  // Restart #2: overlap is valid; current can still sign through retirement boundary.
  verifier = new RestartableVerifier({ trust, statePath, expectedPolicy });
  verifier.verify(signCatalog(currentPair.privateKey, 'catalog-current', 1002, 'current-retirement-boundary', catalog));

  // Restart #3: next owns the trust path after retirement; old root must fail closed.
  verifier = new RestartableVerifier({ trust, statePath, expectedPolicy });
  expectFailure(() => verifier.verify(signCatalog(currentPair.privateKey, 'catalog-current', 1003, 'old-root-after-retirement', catalog)), 'CATALOG_KEY_RETIRED');
  verifier.verify(signCatalog(nextPair.privateKey, 'catalog-next', 1003, 'next-after-retirement', catalog));

  // Restart #4: persisted anti-rollback must reject an older, otherwise valid next-root release.
  verifier = new RestartableVerifier({ trust, statePath, expectedPolicy });
  expectFailure(() => verifier.verify(signCatalog(nextPair.privateKey, 'catalog-next', 1001, 'stale-next-release', catalog)), 'CATALOG_ROLLBACK_DETECTED');

  // Protected rotation policy cannot be silently widened after restart.
  const widened = JSON.parse(JSON.stringify(trust));
  widened.roots.find(root => root.keyId === 'catalog-current').retireAfterSequence = 1004;
  expectFailure(() => new RestartableVerifier({ trust: widened, statePath, expectedPolicy }), 'retireAfterSequence changed');

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (state.highWaterSequence !== 1003 || state.acceptedKeyId !== 'catalog-next') fail('Final persisted cutover state mismatch');
  console.log(`SWIR catalog root cutover E2E OK: current -> next, ${state.highWaterSequence}, restart-safe anti-rollback`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
