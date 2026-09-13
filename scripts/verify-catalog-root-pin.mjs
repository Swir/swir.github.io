import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const ROOT_SCHEMA = 'swir.catalog-trust-roots/1.0';
function fail(message) { throw new Error(message); }
function decodeRawKey(value) {
  const raw = Buffer.from(String(value || ''), 'base64');
  if (raw.length !== 32) fail(`Ed25519 public key must decode to 32 bytes, got ${raw.length}`);
  return raw;
}
function normalizeFingerprint(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) fail('Expected public-root fingerprint must be a 64-hex SHA-256 value');
  return normalized;
}
function verifyRootPin(trustPath, expectedValue, expectedKeyId = '') {
  if (!trustPath) fail('Trust-root document path is required');
  const expected = normalizeFingerprint(expectedValue);
  const trust = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
  if (trust?.schema !== ROOT_SCHEMA || trust.requireSignedCatalog !== true) fail(`Trust document must be fail-closed ${ROOT_SCHEMA}`);
  const enabled = (Array.isArray(trust.roots) ? trust.roots : []).filter(root => root?.enabled !== false && Array.isArray(root?.scope) && root.scope.includes('catalog:official'));
  if (enabled.length !== 1) fail(`Expected exactly one enabled catalog:official root, got ${enabled.length}`);
  const root = enabled[0];
  if (root.algorithm !== 'Ed25519' || root.format !== 'raw') fail('Pinned root must use Ed25519/raw');
  if (expectedKeyId && root.keyId !== expectedKeyId) fail(`Pinned root keyId mismatch: expected ${expectedKeyId}, got ${root.keyId}`);
  const actual = crypto.createHash('sha256').update(decodeRawKey(root.publicKey)).digest('hex');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (!crypto.timingSafeEqual(a, b)) fail(`Catalog public-root fingerprint mismatch: expected ${expected}, got ${actual}`);
  return { keyId: root.keyId, fingerprint: actual };
}
function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-root-pin-'));
  try {
    const raw = crypto.randomBytes(32);
    const fingerprint = crypto.createHash('sha256').update(raw).digest('hex');
    const doc = {
      schema: ROOT_SCHEMA,
      requireSignedCatalog: true,
      roots: [{ keyId: 'ci-root', algorithm: 'Ed25519', format: 'raw', publicKey: raw.toString('base64'), scope: ['catalog:official'], enabled: true }]
    };
    const file = path.join(tmp, 'roots.json');
    fs.writeFileSync(file, JSON.stringify(doc));
    const result = verifyRootPin(file, fingerprint.toUpperCase(), 'ci-root');
    if (result.fingerprint !== fingerprint) fail('Self-test fingerprint mismatch');
    let mismatchBlocked = false;
    try { verifyRootPin(file, '00'.repeat(32), 'ci-root'); } catch (error) { mismatchBlocked = /fingerprint mismatch/i.test(String(error?.message || error)); }
    if (!mismatchBlocked) fail('Self-test expected fingerprint substitution to fail closed');
    let keyIdBlocked = false;
    try { verifyRootPin(file, fingerprint, 'different-root'); } catch (error) { keyIdBlocked = /keyId mismatch/i.test(String(error?.message || error)); }
    if (!keyIdBlocked) fail('Self-test expected keyId substitution to fail closed');
    console.log(`SWIR catalog root pin self-test OK: ${fingerprint}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  const trustPath = process.argv[2];
  const expected = process.argv[3] || process.env.SWIR_CATALOG_EXPECTED_ROOT_SHA256;
  const expectedKeyId = String(process.argv[4] || '').trim();
  const result = verifyRootPin(trustPath, expected, expectedKeyId);
  console.log(`SWIR catalog root pin OK: ${result.keyId} ${result.fingerprint}`);
}
