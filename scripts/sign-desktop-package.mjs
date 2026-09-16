import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SIGNATURE_SCHEMA = 'swir.desktop-package-signature/1.0';
const ROOT_SCHEMA = 'swir.package-trust-roots/1.0';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'self-test') { out.selfTest = true; continue; }
    if (i + 1 >= argv.length) throw new Error(`Missing value for --${key}`);
    out[key] = argv[++i];
  }
  return out;
}

function validateToken(value, name, pattern) {
  const text = String(value || '').trim();
  if (!pattern.test(text)) throw new Error(`${name} contains unsupported characters.`);
  return text;
}

function normalizePrivatePem(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Package signing private key is empty.');
  return text.includes('\\n') && !text.includes('\n') ? text.replace(/\\n/g, '\n') : text;
}

function b64urlToBuffer(value) {
  let text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (text.length % 4) text += '=';
  return Buffer.from(text, 'base64');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(128 * 1024);
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function canonicalPayload({ keyId, packageId, version, sha256 }) {
  return JSON.stringify({
    algorithm: 'Ed25519',
    keyId,
    packageId,
    schema: SIGNATURE_SCHEMA,
    sha256: String(sha256).toLowerCase(),
    version
  });
}

function buildSignature({ packagePath, packageId, version, keyId, privateKeyPem, scope }) {
  const resolved = path.resolve(packagePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Package does not exist or is not a regular file: ${resolved}`);
  }
  if (path.extname(resolved).toLowerCase() !== '.swirapp') {
    throw new Error('Package signing input must use the .swirapp extension.');
  }

  const normalizedPackageId = validateToken(packageId, 'packageId', /^[A-Za-z0-9._-]{1,128}$/);
  const normalizedVersion = validateToken(version, 'version', /^[A-Za-z0-9._+\-]{1,64}$/);
  const normalizedKeyId = validateToken(keyId, 'keyId', /^[A-Za-z0-9._:-]{1,128}$/);
  const normalizedScope = validateScope(scope || `package:${normalizedPackageId}`);

  const privateKey = crypto.createPrivateKey(normalizePrivatePem(privateKeyPem));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Package signing key must be Ed25519, got ${privateKey.asymmetricKeyType || 'unknown'}.`);
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' });
  const rawPublicKey = b64urlToBuffer(jwk.x);
  if (rawPublicKey.length !== 32) throw new Error(`Ed25519 public key must be 32 bytes, got ${rawPublicKey.length}.`);

  const sha256 = sha256File(resolved);
  const payload = canonicalPayload({ keyId: normalizedKeyId, packageId: normalizedPackageId, version: normalizedVersion, sha256 });
  const signatureBytes = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey);
  if (signatureBytes.length !== 64) throw new Error(`Ed25519 signature must be 64 bytes, got ${signatureBytes.length}.`);
  if (!crypto.verify(null, Buffer.from(payload, 'utf8'), publicKey, signatureBytes)) {
    throw new Error('Independent Ed25519 verification failed immediately after signing.');
  }

  const envelope = {
    schema: SIGNATURE_SCHEMA,
    algorithm: 'Ed25519',
    keyId: normalizedKeyId,
    packageId: normalizedPackageId,
    version: normalizedVersion,
    sha256,
    signature: signatureBytes.toString('base64')
  };
  const trustRoots = {
    schema: ROOT_SCHEMA,
    requireSignedPackages: true,
    roots: [{
      keyId: normalizedKeyId,
      name: 'SWIR Desktop Package Release Root',
      algorithm: 'Ed25519',
      format: 'raw',
      publicKey: rawPublicKey.toString('base64'),
      scope: [normalizedScope],
      enabled: true
    }]
  };
  const publicKeySha256 = crypto.createHash('sha256').update(rawPublicKey).digest('hex');
  return { envelope, trustRoots, payload, publicKeySha256 };
}

function validateScope(scope) {
  const value = String(scope || '').trim();
  if (value === '*' || value === 'package:*') return value;
  if (/^package:[A-Za-z0-9._-]{1,128}$/.test(value)) return value;
  throw new Error('scope must be *, package:*, or package:<packageId>.');
}

function writeJson(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (/PRIVATE KEY/.test(text)) throw new Error(`Refusing to write private key material into ${resolved}.`);
  fs.writeFileSync(resolved, text, { encoding: 'utf8', mode: 0o644 });
}

function runSelfTest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-package-signing-'));
  try {
    const packagePath = path.join(temp, 'self-test.swirapp');
    fs.writeFileSync(packagePath, Buffer.from('SWIR package signature producer self-test\n', 'utf8'));
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const result = buildSignature({
      packagePath,
      packageId: 'swir.signature-self-test',
      version: '1.0.0-test+1',
      keyId: 'ci:ephemeral-package-root',
      privateKeyPem: privatePem,
      scope: 'package:swir.signature-self-test'
    });

    const expectedPayload = `{"algorithm":"Ed25519","keyId":"ci:ephemeral-package-root","packageId":"swir.signature-self-test","schema":"${SIGNATURE_SCHEMA}","sha256":"${result.envelope.sha256}","version":"1.0.0-test+1"}`;
    if (result.payload !== expectedPayload) throw new Error('Canonical payload ordering differs from the Desktop verifier contract.');
    if (!/^[a-f0-9]{64}$/.test(result.envelope.sha256)) throw new Error('Self-test digest is not a SHA-256 hex digest.');
    if (Buffer.from(result.envelope.signature, 'base64').length !== 64) throw new Error('Self-test signature length is invalid.');
    if (result.trustRoots.roots[0]?.scope?.[0] !== 'package:swir.signature-self-test') throw new Error('Self-test trust root scope is not least-privilege.');
    if (!/^[a-f0-9]{64}$/.test(result.publicKeySha256)) throw new Error('Self-test public-key fingerprint is invalid.');

    const envelopePath = path.join(temp, 'signature.json');
    const rootPath = path.join(temp, 'package-trust-roots.json');
    writeJson(envelopePath, result.envelope);
    writeJson(rootPath, result.trustRoots);
    for (const output of [envelopePath, rootPath]) {
      if (/PRIVATE KEY/.test(fs.readFileSync(output, 'utf8'))) throw new Error(`Private key leaked into ${output}.`);
    }

    fs.appendFileSync(packagePath, 'tampered');
    if (sha256File(packagePath) === result.envelope.sha256) throw new Error('Tampered package unexpectedly retained the signed digest.');
    console.log(`SWIR package signer self-test OK: key=${result.envelope.keyId}, digest=${result.envelope.sha256}, public-key-sha256=${result.publicKeySha256}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.selfTest) {
  runSelfTest();
} else {
  const packagePath = args.package;
  const packageId = args['package-id'];
  const version = args.version;
  const keyId = args['key-id'];
  const outputPath = args.output;
  if (!packagePath || !packageId || !version || !keyId || !outputPath) {
    throw new Error('Usage: node scripts/sign-desktop-package.mjs --package <file.swirapp> --package-id <id> --version <version> --key-id <id> --output <signature.json> [--scope package:<id>] [--trust-root-output package-trust-roots.json] [--private-key-env SWIR_PACKAGE_SIGNING_PRIVATE_KEY_PEM]');
  }
  const privateKeyEnv = args['private-key-env'] || 'SWIR_PACKAGE_SIGNING_PRIVATE_KEY_PEM';
  const privateKeyPem = process.env[privateKeyEnv];
  const result = buildSignature({ packagePath, packageId, version, keyId, privateKeyPem, scope: args.scope });
  writeJson(outputPath, result.envelope);
  if (args['trust-root-output']) writeJson(args['trust-root-output'], result.trustRoots);
  console.log(JSON.stringify({
    schema: SIGNATURE_SCHEMA,
    packageId: result.envelope.packageId,
    version: result.envelope.version,
    sha256: result.envelope.sha256,
    keyId: result.envelope.keyId,
    publicKeySha256: result.publicKeySha256,
    output: path.resolve(outputPath),
    ...(args['trust-root-output'] ? { trustRootOutput: path.resolve(args['trust-root-output']) } : {})
  }));
}
