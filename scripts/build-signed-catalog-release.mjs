import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import os from 'node:os';

const SCHEMA = 'swir.catalog-signature/1.0';
const RELEASE_SCHEMA = 'swir.signed-catalog-release/1.0';
const ROOT_SCHEMA = 'swir.catalog-trust-roots/1.0';
const ARTIFACT_SCHEMA = 'swir.catalog-artifacts/1.0';

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
function catalogView(catalog) {
  return catalog.map(pkg => stable(pkg)).sort((a, b) =>
    String(a.packageId || a.id || '').localeCompare(String(b.packageId || b.id || '')) ||
    String(a.version || '').localeCompare(String(b.version || '')));
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function b64urlToBuffer(value) {
  let text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (text.length % 4) text += '=';
  return Buffer.from(text, 'base64');
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'self-test') { out.selfTest = true; continue; }
    if (i + 1 >= argv.length) throw new Error(`Missing value for --${key}`);
    out[key] = argv[++i];
  }
  return out;
}
function loadCatalog(sourcePath) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: sourcePath, timeout: 3000 });
  const catalog = sandbox.window.SWIR_PACKAGE_CATALOG;
  if (!Array.isArray(catalog) || !catalog.length) throw new Error('SWIR_PACKAGE_CATALOG must be a non-empty array');
  return JSON.parse(JSON.stringify(catalog));
}
function loadArtifactMap(filePath) {
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (doc?.schema !== ARTIFACT_SCHEMA || !Array.isArray(doc.artifacts)) {
    throw new Error(`Artifact map must use ${ARTIFACT_SCHEMA}`);
  }
  const map = new Map();
  for (const item of doc.artifacts) {
    const packageId = String(item?.packageId || '').trim();
    const version = String(item?.version || '').trim();
    const digest = String(item?.desktop?.sha256 || '').trim().toLowerCase();
    if (!packageId || !version || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Invalid Desktop artifact record for ${packageId || '<missing>'}@${version || '<missing>'}`);
    }
    const key = `${packageId}@${version}`;
    if (map.has(key)) throw new Error(`Duplicate Desktop artifact record: ${key}`);
    map.set(key, { sha256: digest, ...(item.desktop.url ? { url: String(item.desktop.url) } : {}) });
  }
  return map;
}
function mergeArtifacts(catalog, artifactMap) {
  return catalog.map(pkg => {
    const packageId = String(pkg.packageId || '').trim();
    const version = String(pkg.version || '').trim();
    const desktop = artifactMap.get(`${packageId}@${version}`);
    if (!desktop) throw new Error(`Missing Desktop artifact digest for ${packageId}@${version}`);
    return { ...pkg, artifacts: { ...(pkg.artifacts || {}), desktop } };
  });
}
function signedPayload(envelope) {
  return canonicalize({
    schema: SCHEMA,
    catalogId: String(envelope.catalogId),
    catalogVersion: String(envelope.catalogVersion),
    sequence: Number(envelope.sequence),
    catalogSha256: String(envelope.catalogSha256).toLowerCase(),
    generatedAt: String(envelope.generatedAt),
    expiresAt: String(envelope.expiresAt)
  });
}
function normalizePrivatePem(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Catalog signing private key is empty');
  return text.includes('\\n') && !text.includes('\n') ? text.replace(/\\n/g, '\n') : text;
}
function buildRelease({ catalogSource, artifactMapPath, outputDir, keyId, sequence, catalogVersion, privateKeyPem, validHours = 168 }) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) throw new Error('keyId must match ^[A-Za-z0-9._-]{1,128}$');
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('sequence must be a positive safe integer');
  if (!catalogVersion) throw new Error('catalogVersion is required');
  if (!Number.isFinite(validHours) || validHours < 1 || validHours > 24 * 31) throw new Error('validHours must be between 1 and 744');

  const privateKey = crypto.createPrivateKey(normalizePrivatePem(privateKeyPem));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`Catalog signing key must be Ed25519, got ${privateKey.asymmetricKeyType || 'unknown'}`);
  const publicKey = crypto.createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' });
  const rawPublicKey = b64urlToBuffer(jwk.x);
  if (rawPublicKey.length !== 32) throw new Error(`Ed25519 public key must be 32 bytes, got ${rawPublicKey.length}`);

  const artifacts = loadArtifactMap(artifactMapPath);
  const catalog = catalogView(mergeArtifacts(loadCatalog(catalogSource), artifacts));
  const catalogCanonical = canonicalize(catalog);
  const generatedAt = new Date();
  const expiresAt = new Date(generatedAt.getTime() + validHours * 60 * 60 * 1000);
  const envelope = {
    schema: SCHEMA,
    catalogId: 'official',
    catalogVersion: String(catalogVersion),
    sequence,
    catalogSha256: sha256(catalogCanonical),
    generatedAt: generatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    algorithm: 'Ed25519',
    keyId,
    signature: ''
  };
  envelope.signature = crypto.sign(null, Buffer.from(signedPayload(envelope)), privateKey).toString('base64');
  if (!crypto.verify(null, Buffer.from(signedPayload(envelope)), publicKey, Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('Independent Ed25519 verification failed immediately after signing');
  }

  const trustRoots = {
    schema: ROOT_SCHEMA,
    requireSignedCatalog: true,
    roots: [{
      keyId,
      name: 'SWIR Official Catalog Release Root',
      algorithm: 'Ed25519',
      format: 'raw',
      publicKey: rawPublicKey.toString('base64'),
      scope: ['catalog:official'],
      enabled: true
    }]
  };
  const release = { schema: RELEASE_SCHEMA, catalog, envelope };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'catalog-envelope.json'), `${JSON.stringify(envelope, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'catalog-trust-roots.json'), `${JSON.stringify(trustRoots, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'swir-signed-catalog-release.js'), `/* generated by build-signed-catalog-release.mjs; contains PUBLIC metadata only */\n(() => {\n  const host = (() => { try { return window.parent && window.parent !== window ? window.parent : window; } catch { return window; } })();\n  host.SWIR_SIGNED_CATALOG_RELEASE = Object.freeze(${JSON.stringify(release)});\n})();\n`);
  fs.writeFileSync(path.join(outputDir, 'signed-catalog-release.json'), `${JSON.stringify(release, null, 2)}\n`);

  return { release, trustRoots, rawPublicKey };
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-catalog-release-'));
  try {
    const catalogSource = path.resolve('swir-packages.js');
    const catalog = loadCatalog(catalogSource);
    const artifacts = {
      schema: ARTIFACT_SCHEMA,
      artifacts: catalog.map(pkg => ({
        packageId: pkg.packageId,
        version: pkg.version,
        desktop: { sha256: sha256(`self-test:${pkg.packageId}@${pkg.version}`) }
      }))
    };
    const artifactMapPath = path.join(tmp, 'artifacts.json');
    fs.writeFileSync(artifactMapPath, JSON.stringify(artifacts));
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const result = buildRelease({
      catalogSource,
      artifactMapPath,
      outputDir: path.join(tmp, 'out'),
      keyId: 'ci-ephemeral-ed25519',
      sequence: 4242,
      catalogVersion: 'ci-self-test',
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      validHours: 24
    });
    const envelope = result.release.envelope;
    const actualDigest = sha256(canonicalize(catalogView(result.release.catalog)));
    if (actualDigest !== envelope.catalogSha256) throw new Error('Self-test catalog digest mismatch');
    if (!result.release.catalog.every(pkg => /^[a-f0-9]{64}$/.test(pkg?.artifacts?.desktop?.sha256 || ''))) throw new Error('Self-test signed catalog lacks Desktop digests');
    if (!result.trustRoots.requireSignedCatalog || result.trustRoots.roots[0]?.scope?.[0] !== 'catalog:official') throw new Error('Self-test trust-root policy mismatch');
    for (const required of ['catalog.json','catalog-envelope.json','catalog-trust-roots.json','swir-signed-catalog-release.js','signed-catalog-release.json']) {
      if (!fs.existsSync(path.join(tmp, 'out', required))) throw new Error(`Self-test output missing: ${required}`);
    }
    console.log(`SWIR signed catalog release builder self-test OK: ${result.release.catalog.length} packages, sequence ${envelope.sequence}, digest ${envelope.catalogSha256}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.selfTest) {
  runSelfTest();
} else {
  const privateKeyEnv = args['private-key-env'] || 'SWIR_CATALOG_SIGNING_PRIVATE_KEY_PEM';
  const outputDir = path.resolve(args['output-dir'] || 'signed-catalog-release');
  const result = buildRelease({
    catalogSource: path.resolve(args['catalog-source'] || 'swir-packages.js'),
    artifactMapPath: path.resolve(args['artifact-map'] || ''),
    outputDir,
    keyId: String(args['key-id'] || ''),
    sequence: Number(args.sequence),
    catalogVersion: String(args['catalog-version'] || ''),
    privateKeyPem: process.env[privateKeyEnv],
    validHours: Number(args['valid-hours'] || 168)
  });
  console.log(`Signed SWIR catalog release written to ${outputDir}: ${result.release.catalog.length} packages, sequence ${result.release.envelope.sequence}, digest ${result.release.envelope.catalogSha256}`);
}
