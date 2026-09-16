import crypto from 'node:crypto';

const SIGNATURE_SCHEMA = 'swir.catalog-signature/1.0';
const ROOT_SCHEMA = 'swir.catalog-trust-roots/1.0';
const AUTH_SCHEMA = 'swir.system-catalog-authorization/0.1';
const CATALOG_ID = 'official';
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/;
const VERIFIED = new WeakSet();

function fail(code, message) {
  const error = new Error(message);
  error.name = 'SystemCatalogTrustError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

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

function canonicalize(value) {
  return JSON.stringify(stable(value));
}

function catalogView(catalog) {
  assert(Array.isArray(catalog), 'INVALID_CATALOG', 'Package catalog must be an array');
  return catalog.map(record => stable(record)).sort((a, b) =>
    String(a.packageId || a.id || '').localeCompare(String(b.packageId || b.id || '')) ||
    String(a.version || '').localeCompare(String(b.version || ''))
  );
}

function fingerprintCatalog(catalog) {
  return crypto.createHash('sha256').update(canonicalize(catalogView(catalog))).digest('hex');
}

function signedPayload(envelope) {
  return canonicalize({
    schema: SIGNATURE_SCHEMA,
    catalogId: String(envelope.catalogId),
    catalogVersion: String(envelope.catalogVersion),
    sequence: Number(envelope.sequence),
    catalogSha256: String(envelope.catalogSha256 || '').trim().toLowerCase().replace(/^sha256[-:]/, ''),
    generatedAt: String(envelope.generatedAt || ''),
    expiresAt: String(envelope.expiresAt || '')
  });
}

function isoMs(value) {
  const text = String(value || '');
  const parsed = Date.parse(text);
  return text && Number.isFinite(parsed) && /Z$/i.test(text) ? parsed : null;
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function createEd25519PublicKey(root) {
  assert(root?.algorithm === 'Ed25519', 'UNSUPPORTED_ROOT_ALGORITHM', 'Catalog trust root must use Ed25519');
  assert(root?.format === 'raw', 'UNSUPPORTED_ROOT_FORMAT', 'System catalog verifier currently accepts raw Ed25519 public roots only');
  const raw = Buffer.from(String(root.publicKey || ''), 'base64');
  assert(raw.length === 32, 'INVALID_ROOT_KEY', 'Ed25519 raw public root must decode to 32 bytes');
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(raw) }, format: 'jwk' });
}

function validateEnvelope(envelope) {
  assert(envelope && typeof envelope === 'object' && !Array.isArray(envelope), 'INVALID_ENVELOPE', 'Signed catalog envelope is required');
  assert(envelope.schema === SIGNATURE_SCHEMA, 'INVALID_ENVELOPE_SCHEMA', `Catalog envelope must use ${SIGNATURE_SCHEMA}`);
  assert(envelope.catalogId === CATALOG_ID, 'CATALOG_ID_MISMATCH', 'Only the official SWIR catalog is trusted for System package authorization');
  assert(typeof envelope.catalogVersion === 'string' && envelope.catalogVersion.length > 0, 'INVALID_CATALOG_VERSION', 'catalogVersion is required');
  assert(Number.isSafeInteger(envelope.sequence) && envelope.sequence > 0, 'INVALID_SEQUENCE', 'Catalog sequence must be a positive safe integer');
  const generatedAt = isoMs(envelope.generatedAt);
  const expiresAt = isoMs(envelope.expiresAt);
  assert(generatedAt !== null, 'INVALID_GENERATED_AT', 'generatedAt must be an ISO UTC instant');
  assert(expiresAt !== null && expiresAt > generatedAt, 'INVALID_EXPIRES_AT', 'expiresAt must be an ISO UTC instant after generatedAt');
  assert(envelope.algorithm === 'Ed25519', 'UNSUPPORTED_SIGNATURE_ALGORITHM', 'Catalog signature algorithm must be Ed25519');
  assert(typeof envelope.keyId === 'string' && envelope.keyId.length > 0, 'INVALID_KEY_ID', 'Catalog keyId is required');
  const digest = String(envelope.catalogSha256 || '').trim().toLowerCase().replace(/^sha256[-:]/, '');
  assert(SHA256.test(digest), 'INVALID_CATALOG_DIGEST', 'Catalog envelope requires a SHA-256 digest');
  assert(typeof envelope.signature === 'string' && envelope.signature.length > 0, 'INVALID_SIGNATURE', 'Catalog signature is required');
  return { generatedAt, expiresAt, digest };
}

function trustedRootFor(document, keyId) {
  assert(document?.schema === ROOT_SCHEMA, 'INVALID_TRUST_ROOT_SCHEMA', `Trust roots must use ${ROOT_SCHEMA}`);
  assert(document.requireSignedCatalog === true, 'SIGNED_CATALOG_NOT_REQUIRED', 'System trust roots must fail closed with requireSignedCatalog=true');
  const roots = Array.isArray(document.roots) ? document.roots : [];
  const candidates = roots.filter(root => root?.enabled !== false && root?.keyId === keyId && Array.isArray(root?.scope) && root.scope.includes('catalog:official'));
  assert(candidates.length === 1, 'TRUST_ROOT_NOT_FOUND', 'Exactly one enabled catalog:official root must match the envelope keyId');
  return candidates[0];
}

function findCatalogRecord(catalog, manifest) {
  const version = String(manifest?.package?.version || '');
  assert(version.length > 0, 'PACKAGE_VERSION_REQUIRED', 'Signed System package authorization requires an exact package version');
  const matches = catalogView(catalog).filter(record => String(record.packageId || record.id || '') === manifest.id && String(record.version || '') === version);
  assert(matches.length === 1, 'CATALOG_PACKAGE_NOT_FOUND', 'Signed catalog must contain exactly one matching package id/version record');
  return matches[0];
}

function appImageArtifact(record) {
  const artifact = record?.artifacts?.system?.appimage;
  assert(artifact && typeof artifact === 'object' && !Array.isArray(artifact), 'APPIMAGE_ARTIFACT_NOT_AUTHORIZED', 'Signed catalog record does not authorize a System AppImage artifact');
  assert(artifact.provider === 'swir.package.appimage', 'APPIMAGE_PROVIDER_MISMATCH', 'Signed catalog AppImage provider binding is invalid');
  assert(typeof artifact.sourceRef === 'string' && artifact.sourceRef.length > 0, 'APPIMAGE_SOURCE_REF_MISSING', 'Signed catalog AppImage sourceRef is required');
  assert(SHA256.test(String(artifact.sha256 || '')), 'APPIMAGE_DIGEST_MISSING', 'Signed catalog AppImage SHA-256 is required');
  return artifact;
}

export class MemoryCatalogTrustState {
  #state = null;
  async read() { return this.#state ? structuredClone(this.#state) : null; }
  async accept(state) { this.#state = structuredClone(state); return this.read(); }
}

export class SystemCatalogTrustVerifier {
  #roots;
  #stateStore;
  #maxClockSkewMs;

  constructor({ trustRoots, stateStore, maxClockSkewMs = DEFAULT_MAX_CLOCK_SKEW_MS } = {}) {
    assert(trustRoots && typeof trustRoots === 'object', 'TRUST_ROOTS_REQUIRED', 'System catalog trust roots are required');
    assert(stateStore && typeof stateStore.read === 'function' && typeof stateStore.accept === 'function', 'TRUST_STATE_REQUIRED', 'Persistent catalog trust state adapter is required');
    assert(Number.isFinite(maxClockSkewMs) && maxClockSkewMs >= 0, 'INVALID_CLOCK_SKEW', 'maxClockSkewMs must be a non-negative number');
    this.#roots = structuredClone(trustRoots);
    this.#stateStore = stateStore;
    this.#maxClockSkewMs = Number(maxClockSkewMs);
  }

  async authorizeAppImage(manifest, { catalog, envelope, now = Date.now() } = {}) {
    assert(manifest?.provider === 'swir.package.appimage', 'WRONG_PROVIDER', 'System catalog AppImage authorization requires swir.package.appimage');
    assert(manifest?.trust?.sourceClass === 'swir-signed' && manifest?.trust?.signatureRequired === true, 'UNSIGNED_MANIFEST', 'AppImage manifest must require SWIR signed trust');
    assert(manifest?.trust?.repositoryId === CATALOG_ID, 'REPOSITORY_ID_MISMATCH', 'AppImage manifest must bind to the official catalog');
    const descriptor = validateEnvelope(envelope);
    const verificationNow = Number(now);
    assert(Number.isFinite(verificationNow), 'INVALID_VERIFICATION_TIME', 'Verification time must be finite');
    assert(descriptor.generatedAt <= verificationNow + this.#maxClockSkewMs, 'FUTURE_METADATA', 'Catalog metadata is dated too far in the future');
    assert(descriptor.expiresAt >= verificationNow - this.#maxClockSkewMs, 'EXPIRED', 'Catalog metadata has expired');

    const previous = await this.#stateStore.read();
    const minimumSequence = Number.isSafeInteger(previous?.sequence) ? previous.sequence : 0;
    assert(envelope.sequence >= minimumSequence, 'ROLLBACK_DETECTED', 'Catalog sequence is older than the trusted high-water mark');
    if (minimumSequence > 0 && envelope.sequence === minimumSequence && previous?.catalogSha256) {
      assert(String(previous.catalogSha256).toLowerCase() === descriptor.digest, 'EQUIVOCATION_DETECTED', 'Catalog sequence was reused with different signed content');
    }

    const actualDigest = fingerprintCatalog(catalog);
    assert(actualDigest === descriptor.digest, 'CATALOG_MISMATCH', 'Signed catalog digest does not match catalog content');
    const root = trustedRootFor(this.#roots, envelope.keyId);
    const publicKey = createEd25519PublicKey(root);
    const signature = Buffer.from(String(envelope.signature).replace(/^base64:/i, '').replace(/\s+/g, ''), 'base64');
    assert(signature.length === 64, 'INVALID_SIGNATURE', 'Ed25519 signature must decode to 64 bytes');
    assert(crypto.verify(null, Buffer.from(signedPayload(envelope)), publicKey, signature), 'BAD_SIGNATURE', 'Cryptographic catalog signature verification failed');

    const record = findCatalogRecord(catalog, manifest);
    const artifact = appImageArtifact(record);
    assert(artifact.sourceRef === manifest.package?.sourceRef, 'SOURCE_REF_MISMATCH', 'Manifest sourceRef is not authorized by the signed catalog');
    assert(artifact.sha256 === manifest.package?.sha256, 'PACKAGE_DIGEST_MISMATCH', 'Manifest SHA-256 is not authorized by the signed catalog');

    await this.#stateStore.accept({
      schema: 'swir.catalog-trust-state/1.0',
      catalogId: CATALOG_ID,
      catalogVersion: envelope.catalogVersion,
      sequence: envelope.sequence,
      catalogSha256: descriptor.digest,
      keyId: envelope.keyId,
      generatedAt: envelope.generatedAt,
      expiresAt: envelope.expiresAt,
      acceptedAt: new Date(verificationNow).toISOString()
    });

    const authorization = Object.freeze({
      schema: AUTH_SCHEMA,
      provider: 'swir.package.appimage',
      packageId: manifest.id,
      version: manifest.package.version,
      sourceRef: artifact.sourceRef,
      sha256: artifact.sha256,
      catalogId: CATALOG_ID,
      catalogVersion: envelope.catalogVersion,
      sequence: envelope.sequence,
      keyId: envelope.keyId,
      expiresAt: envelope.expiresAt,
      verifiedAt: new Date(verificationNow).toISOString()
    });
    VERIFIED.add(authorization);
    return authorization;
  }
}

export function isVerifiedSystemCatalogAuthorization(value) {
  return Boolean(value && typeof value === 'object' && VERIFIED.has(value));
}

export const SystemCatalogTrustPolicy = Object.freeze({
  signatureSchema: SIGNATURE_SCHEMA,
  trustRootSchema: ROOT_SCHEMA,
  authorizationSchema: AUTH_SCHEMA,
  catalogId: CATALOG_ID,
  algorithm: 'Ed25519',
  trustScope: 'catalog:official',
  failClosed: true,
  freshnessRequired: true,
  antiRollback: true,
  sameSequenceEquivocationRejected: true,
  exactPackageVersionBinding: true,
  exactAppImageDigestBinding: true,
  privateSigningKeyInRuntime: false
});

export const SystemCatalogTrustInternals = Object.freeze({ canonicalize, catalogView, fingerprintCatalog, signedPayload });
