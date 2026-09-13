import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const ROOT_SCHEMA = 'swir.catalog-trust-roots/1.0';
function fail(message) { throw new Error(message); }
function positive(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) fail(`${label} must be a positive safe integer`);
  return n;
}
function fingerprint(raw) { return crypto.createHash('sha256').update(raw).digest('hex'); }
function normalizeFingerprint(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) fail(`${label} must be a 64-hex SHA-256 fingerprint`);
  return text;
}
function decodePublicKey(value, label) {
  const raw = Buffer.from(String(value || '').trim(), 'base64');
  if (raw.length !== 32) fail(`${label} must decode to exactly 32 bytes`);
  return raw;
}
function safeEqualHex(a, b) {
  const aa = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function applyRotation({ trustPath, currentKeyId, currentFingerprint, nextKeyId, nextPublicKeyBase64, nextFingerprint, cutoverSequence, currentRetireAfterSequence }) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(currentKeyId || '')) fail('Invalid currentKeyId');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(nextKeyId || '')) fail('Invalid nextKeyId');
  if (currentKeyId === nextKeyId) fail('Current and next key IDs must differ');
  const cutover = positive(cutoverSequence, 'cutoverSequence');
  const retireAfter = positive(currentRetireAfterSequence, 'currentRetireAfterSequence');
  if (retireAfter < cutover) fail('currentRetireAfterSequence must be >= cutoverSequence');

  const trust = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
  if (trust?.schema !== ROOT_SCHEMA || trust.requireSignedCatalog !== true) fail(`Trust document must be fail-closed ${ROOT_SCHEMA}`);
  const enabledOfficial = (Array.isArray(trust.roots) ? trust.roots : []).filter(root => root?.enabled !== false && Array.isArray(root?.scope) && root.scope.includes('catalog:official'));
  if (enabledOfficial.length !== 1) fail(`Rotation input must start with exactly one enabled catalog:official root, got ${enabledOfficial.length}`);
  const current = enabledOfficial[0];
  if (current.keyId !== currentKeyId || current.algorithm !== 'Ed25519' || current.format !== 'raw') fail('Current root identity/algorithm mismatch');
  const currentRaw = decodePublicKey(current.publicKey, 'Current public key');
  const expectedCurrent = normalizeFingerprint(currentFingerprint, 'Current fingerprint');
  const actualCurrent = fingerprint(currentRaw);
  if (!safeEqualHex(actualCurrent, expectedCurrent)) fail(`Current root fingerprint mismatch: expected ${expectedCurrent}, got ${actualCurrent}`);

  const nextRaw = decodePublicKey(nextPublicKeyBase64, 'Next public key');
  const expectedNext = normalizeFingerprint(nextFingerprint, 'Next fingerprint');
  const actualNext = fingerprint(nextRaw);
  if (!safeEqualHex(actualNext, expectedNext)) fail(`Next root fingerprint mismatch: expected ${expectedNext}, got ${actualNext}`);
  if (safeEqualHex(actualCurrent, actualNext)) fail('Next root must use different public key material');

  const currentRoot = { ...current, notBeforeSequence: 1, retireAfterSequence: retireAfter };
  const nextRoot = {
    keyId: nextKeyId,
    name: 'SWIR Official Catalog Next Root',
    algorithm: 'Ed25519',
    format: 'raw',
    publicKey: nextRaw.toString('base64'),
    scope: ['catalog:official'],
    enabled: true,
    notBeforeSequence: cutover
  };
  const output = { ...trust, roots: [currentRoot, nextRoot] };
  const tempPath = `${trustPath}.rotation.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, trustPath);
  return { currentFingerprint: actualCurrent, nextFingerprint: actualNext, cutoverSequence: cutover, currentRetireAfterSequence: retireAfter };
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-apply-rotation-'));
  try {
    const currentRaw = crypto.randomBytes(32);
    const nextRaw = crypto.randomBytes(32);
    const file = path.join(tmp, 'roots.json');
    fs.writeFileSync(file, JSON.stringify({
      schema: ROOT_SCHEMA,
      requireSignedCatalog: true,
      roots: [{ keyId: 'current', name: 'current', algorithm: 'Ed25519', format: 'raw', publicKey: currentRaw.toString('base64'), scope: ['catalog:official'], enabled: true }]
    }));
    const currentFingerprint = fingerprint(currentRaw);
    const nextFingerprint = fingerprint(nextRaw);
    applyRotation({ trustPath: file, currentKeyId: 'current', currentFingerprint, nextKeyId: 'next', nextPublicKeyBase64: nextRaw.toString('base64'), nextFingerprint, cutoverSequence: 100, currentRetireAfterSequence: 105 });
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (result.roots?.length !== 2 || result.roots[0].retireAfterSequence !== 105 || result.roots[1].notBeforeSequence !== 100) fail('Self-test rotation output mismatch');

    const reset = () => fs.writeFileSync(file, JSON.stringify({ schema: ROOT_SCHEMA, requireSignedCatalog: true, roots: [{ keyId: 'current', algorithm: 'Ed25519', format: 'raw', publicKey: currentRaw.toString('base64'), scope: ['catalog:official'], enabled: true }] }));
    reset();
    let badPinBlocked = false;
    try { applyRotation({ trustPath: file, currentKeyId: 'current', currentFingerprint, nextKeyId: 'next', nextPublicKeyBase64: nextRaw.toString('base64'), nextFingerprint: '00'.repeat(32), cutoverSequence: 100, currentRetireAfterSequence: 105 }); } catch (error) { badPinBlocked = /Next root fingerprint mismatch/.test(String(error?.message || error)); }
    if (!badPinBlocked) fail('Self-test expected next-root pin substitution to fail closed');

    reset();
    let invertedWindowBlocked = false;
    try { applyRotation({ trustPath: file, currentKeyId: 'current', currentFingerprint, nextKeyId: 'next', nextPublicKeyBase64: nextRaw.toString('base64'), nextFingerprint, cutoverSequence: 105, currentRetireAfterSequence: 104 }); } catch (error) { invertedWindowBlocked = />= cutoverSequence/.test(String(error?.message || error)); }
    if (!invertedWindowBlocked) fail('Self-test expected inverted rotation window to fail closed');
    console.log('SWIR catalog root rotation applicator self-test OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  applyRotation({
    trustPath: process.argv[2],
    currentFingerprint: process.argv[3] || process.env.SWIR_CATALOG_EXPECTED_ROOT_SHA256,
    currentKeyId: process.argv[4],
    nextPublicKeyBase64: process.argv[5] || process.env.SWIR_CATALOG_NEXT_PUBLIC_KEY_BASE64,
    nextFingerprint: process.argv[6] || process.env.SWIR_CATALOG_NEXT_EXPECTED_ROOT_SHA256,
    nextKeyId: process.argv[7],
    cutoverSequence: process.argv[8] || process.env.SWIR_CATALOG_ROTATION_CUTOVER_SEQUENCE,
    currentRetireAfterSequence: process.argv[9] || process.env.SWIR_CATALOG_CURRENT_RETIRE_AFTER_SEQUENCE
  });
  console.log('SWIR catalog trust bundle rotation applied and pinned');
}
