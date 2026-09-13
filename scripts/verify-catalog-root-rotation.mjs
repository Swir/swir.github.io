import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const ROOT_SCHEMA = 'swir.catalog-trust-roots/1.0';
function fail(message) { throw new Error(message); }
function normalizeFingerprint(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) fail(`${label} fingerprint must be a 64-hex SHA-256 value`);
  return normalized;
}
function normalizePositiveInt(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) fail(`${label} must be a positive safe integer`);
  return n;
}
function rawKey(root) {
  if (root?.algorithm !== 'Ed25519' || root?.format !== 'raw') fail(`Root ${root?.keyId || '<missing>'} must use Ed25519/raw`);
  const raw = Buffer.from(String(root?.publicKey || ''), 'base64');
  if (raw.length !== 32) fail(`Root ${root?.keyId || '<missing>'} public key must decode to 32 bytes`);
  return raw;
}
function fingerprint(root) { return crypto.createHash('sha256').update(rawKey(root)).digest('hex'); }
function equalHex(actual, expected, label) {
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail(`${label} fingerprint mismatch: expected ${expected}, got ${actual}`);
}

function verifyRotation(trustPath, expected) {
  const trust = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
  if (trust?.schema !== ROOT_SCHEMA || trust.requireSignedCatalog !== true) fail(`Trust document must be fail-closed ${ROOT_SCHEMA}`);
  const roots = (Array.isArray(trust.roots) ? trust.roots : []).filter(root => root?.enabled !== false && Array.isArray(root?.scope) && root.scope.includes('catalog:official'));
  if (roots.length !== 2) fail(`Rotation bundle must contain exactly two enabled catalog:official roots, got ${roots.length}`);

  const currentKeyId = String(expected.currentKeyId || '').trim();
  const nextKeyId = String(expected.nextKeyId || '').trim();
  if (!currentKeyId || !nextKeyId || currentKeyId === nextKeyId) fail('Rotation requires distinct current and next key IDs');
  const current = roots.find(root => root.keyId === currentKeyId);
  const next = roots.find(root => root.keyId === nextKeyId);
  if (!current || !next) fail('Rotation bundle does not contain the expected current and next roots');

  const currentExpected = normalizeFingerprint(expected.currentFingerprint, 'Current root');
  const nextExpected = normalizeFingerprint(expected.nextFingerprint, 'Next root');
  if (currentExpected === nextExpected) fail('Current and next root fingerprints must differ');
  const currentActual = fingerprint(current);
  const nextActual = fingerprint(next);
  equalHex(currentActual, currentExpected, 'Current root');
  equalHex(nextActual, nextExpected, 'Next root');

  const cutover = normalizePositiveInt(expected.cutoverSequence, 'cutoverSequence');
  const retireAfter = normalizePositiveInt(expected.currentRetireAfterSequence, 'currentRetireAfterSequence');
  if (retireAfter < cutover) fail('currentRetireAfterSequence must be >= cutoverSequence');
  const currentNotBefore = current.notBeforeSequence == null ? 1 : normalizePositiveInt(current.notBeforeSequence, 'current.notBeforeSequence');
  const currentRetire = normalizePositiveInt(current.retireAfterSequence, 'current.retireAfterSequence');
  const nextNotBefore = normalizePositiveInt(next.notBeforeSequence, 'next.notBeforeSequence');
  if (currentNotBefore !== 1) fail(`Current root notBeforeSequence must remain 1 during this rotation contract, got ${currentNotBefore}`);
  if (currentRetire !== retireAfter) fail(`Current root retireAfterSequence mismatch: expected ${retireAfter}, got ${currentRetire}`);
  if (nextNotBefore !== cutover) fail(`Next root notBeforeSequence mismatch: expected ${cutover}, got ${nextNotBefore}`);
  if (next.retireAfterSequence != null) fail('Next root must not be pre-retired in a current->next rotation bundle');

  return {
    currentKeyId,
    nextKeyId,
    currentFingerprint: currentActual,
    nextFingerprint: nextActual,
    cutoverSequence: cutover,
    currentRetireAfterSequence: retireAfter,
    overlapSequences: retireAfter - cutover + 1
  };
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-root-rotation-'));
  try {
    const currentRaw = crypto.randomBytes(32);
    const nextRaw = crypto.randomBytes(32);
    const currentFingerprint = crypto.createHash('sha256').update(currentRaw).digest('hex');
    const nextFingerprint = crypto.createHash('sha256').update(nextRaw).digest('hex');
    const file = path.join(tmp, 'roots.json');
    const write = retireAfterSequence => fs.writeFileSync(file, JSON.stringify({
      schema: ROOT_SCHEMA,
      requireSignedCatalog: true,
      roots: [
        { keyId: 'current-root', algorithm: 'Ed25519', format: 'raw', publicKey: currentRaw.toString('base64'), scope: ['catalog:official'], enabled: true, notBeforeSequence: 1, retireAfterSequence },
        { keyId: 'next-root', algorithm: 'Ed25519', format: 'raw', publicKey: nextRaw.toString('base64'), scope: ['catalog:official'], enabled: true, notBeforeSequence: 100 }
      ]
    }));
    write(105);
    const expected = { currentKeyId: 'current-root', nextKeyId: 'next-root', currentFingerprint, nextFingerprint, cutoverSequence: 100, currentRetireAfterSequence: 105 };
    const result = verifyRotation(file, expected);
    if (result.overlapSequences !== 6) fail('Self-test overlap calculation mismatch');

    write(106);
    let extensionBlocked = false;
    try { verifyRotation(file, expected); } catch (error) { extensionBlocked = /retireAfterSequence mismatch/i.test(String(error?.message || error)); }
    if (!extensionBlocked) fail('Self-test expected accidental extension of current root window to fail closed');

    write(105);
    const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
    tampered.roots[1].notBeforeSequence = 99;
    fs.writeFileSync(file, JSON.stringify(tampered));
    let earlyActivationBlocked = false;
    try { verifyRotation(file, expected); } catch (error) { earlyActivationBlocked = /notBeforeSequence mismatch/i.test(String(error?.message || error)); }
    if (!earlyActivationBlocked) fail('Self-test expected next-root early activation to fail closed');

    console.log(`SWIR catalog root rotation self-test OK: cutover ${result.cutoverSequence}, retire ${result.currentRetireAfterSequence}, overlap ${result.overlapSequences}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  const result = verifyRotation(process.argv[2], {
    currentFingerprint: process.argv[3] || process.env.SWIR_CATALOG_EXPECTED_ROOT_SHA256,
    currentKeyId: process.argv[4],
    nextFingerprint: process.argv[5] || process.env.SWIR_CATALOG_NEXT_EXPECTED_ROOT_SHA256,
    nextKeyId: process.argv[6],
    cutoverSequence: process.argv[7] || process.env.SWIR_CATALOG_ROTATION_CUTOVER_SEQUENCE,
    currentRetireAfterSequence: process.argv[8] || process.env.SWIR_CATALOG_CURRENT_RETIRE_AFTER_SEQUENCE
  });
  console.log(`SWIR catalog root rotation OK: ${result.currentKeyId} -> ${result.nextKeyId}, cutover ${result.cutoverSequence}, current retires ${result.currentRetireAfterSequence}`);
}
