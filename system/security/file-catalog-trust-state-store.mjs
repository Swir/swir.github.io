import fs from 'node:fs';
import path from 'node:path';

const fsp = fs.promises;
const STATE_SCHEMA = 'swir.catalog-trust-state/1.0';
const CATALOG_ID = 'official';
const SHA256 = /^[a-f0-9]{64}$/;
const STATE_FILE = /^seq-(\d{16})-([a-f0-9]{64})\.json$/;

function fail(code, message) {
  const error = new Error(message);
  error.name = 'FileCatalogTrustStateError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function validUtc(value) {
  const text = String(value || '');
  return /Z$/i.test(text) && Number.isFinite(Date.parse(text));
}

function normalizeState(state) {
  assert(state && typeof state === 'object' && !Array.isArray(state), 'INVALID_STATE', 'Catalog trust state must be an object');
  assert(state.schema === STATE_SCHEMA, 'STATE_SCHEMA_MISMATCH', `Catalog trust state must use ${STATE_SCHEMA}`);
  assert(state.catalogId === CATALOG_ID, 'CATALOG_ID_MISMATCH', 'Catalog trust state must belong to the official catalog');
  assert(typeof state.catalogVersion === 'string' && state.catalogVersion.length > 0, 'INVALID_CATALOG_VERSION', 'Catalog trust state requires catalogVersion');
  assert(Number.isSafeInteger(state.sequence) && state.sequence > 0, 'INVALID_SEQUENCE', 'Catalog trust state sequence must be a positive safe integer');
  const digest = String(state.catalogSha256 || '').toLowerCase();
  assert(SHA256.test(digest), 'INVALID_CATALOG_DIGEST', 'Catalog trust state requires a SHA-256 catalog digest');
  assert(typeof state.keyId === 'string' && state.keyId.length > 0, 'INVALID_KEY_ID', 'Catalog trust state requires keyId');
  assert(validUtc(state.generatedAt), 'INVALID_GENERATED_AT', 'Catalog trust state generatedAt must be an ISO UTC instant');
  assert(validUtc(state.expiresAt) && Date.parse(state.expiresAt) > Date.parse(state.generatedAt), 'INVALID_EXPIRES_AT', 'Catalog trust state expiresAt must be after generatedAt');
  assert(validUtc(state.acceptedAt), 'INVALID_ACCEPTED_AT', 'Catalog trust state acceptedAt must be an ISO UTC instant');
  return Object.freeze({
    schema: STATE_SCHEMA,
    catalogId: CATALOG_ID,
    catalogVersion: state.catalogVersion,
    sequence: state.sequence,
    catalogSha256: digest,
    keyId: state.keyId,
    generatedAt: state.generatedAt,
    expiresAt: state.expiresAt,
    acceptedAt: state.acceptedAt
  });
}

function sequenceName(sequence) {
  return String(sequence).padStart(16, '0');
}

function stateFileName(state) {
  return `seq-${sequenceName(state.sequence)}-${state.catalogSha256}.json`;
}

function sameSignedState(a, b) {
  return a.sequence === b.sequence &&
    a.catalogSha256 === b.catalogSha256 &&
    a.catalogVersion === b.catalogVersion &&
    a.keyId === b.keyId &&
    a.generatedAt === b.generatedAt &&
    a.expiresAt === b.expiresAt;
}

export class FileCatalogTrustStateStore {
  #root;
  #expectedOwnerUid;

  constructor({ stateRoot, expectedOwnerUid = 0 } = {}) {
    assert(typeof stateRoot === 'string' && stateRoot.length > 0 && path.isAbsolute(stateRoot), 'STATE_ROOT_REQUIRED', 'Persistent catalog trust state requires an absolute stateRoot');
    assert(expectedOwnerUid === null || (Number.isInteger(expectedOwnerUid) && expectedOwnerUid >= 0), 'INVALID_OWNER_UID', 'expectedOwnerUid must be a non-negative integer or null');
    this.#root = path.resolve(stateRoot);
    this.#expectedOwnerUid = expectedOwnerUid;
  }

  describe() {
    return Object.freeze({
      schema: 'swir.catalog-trust-state-store/0.1',
      backend: 'append-only-files',
      catalogId: CATALOG_ID,
      stateRoot: this.#root,
      expectedOwnerUid: this.#expectedOwnerUid,
      atomicCreate: true,
      monotonicHighWater: true,
      concurrentRollbackResistant: true,
      sameSequenceEquivocationFailClosed: true
    });
  }

  async #assertRoot() {
    let stat;
    try {
      stat = await fsp.lstat(this.#root);
    } catch (error) {
      if (error?.code === 'ENOENT') fail('STATE_ROOT_MISSING', `Catalog trust state root does not exist: ${this.#root}`);
      throw error;
    }
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_STATE_ROOT', 'Catalog trust state root must be a real directory, not a symlink');
    assert((stat.mode & 0o022) === 0, 'UNSAFE_STATE_ROOT_MODE', 'Catalog trust state root must not be writable by group or others');
    if (this.#expectedOwnerUid !== null && typeof stat.uid === 'number') {
      assert(stat.uid === this.#expectedOwnerUid, 'UNSAFE_STATE_ROOT_OWNER', 'Catalog trust state root owner does not match the configured trusted UID');
    }
    const real = await fsp.realpath(this.#root);
    assert(real === this.#root, 'UNSAFE_STATE_ROOT_PATH', 'Catalog trust state root must not traverse symbolic links');
    return stat;
  }

  async #readFile(fileName) {
    assert(STATE_FILE.test(fileName), 'INVALID_STATE_FILE', 'Catalog trust state file name is invalid');
    const filePath = path.join(this.#root, fileName);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    const handle = await fsp.open(filePath, flags);
    try {
      const stat = await handle.stat();
      assert(stat.isFile(), 'UNSAFE_STATE_FILE', 'Catalog trust state entry must be a regular file');
      assert((stat.mode & 0o077) === 0, 'UNSAFE_STATE_FILE_MODE', 'Catalog trust state entry must not be accessible by group or others');
      if (this.#expectedOwnerUid !== null && typeof stat.uid === 'number') {
        assert(stat.uid === this.#expectedOwnerUid, 'UNSAFE_STATE_FILE_OWNER', 'Catalog trust state entry owner does not match the configured trusted UID');
      }
      const text = await handle.readFile({ encoding: 'utf8' });
      assert(text.length > 0 && text.length <= 16384, 'INVALID_STATE_SIZE', 'Catalog trust state entry size is invalid');
      let parsed;
      try { parsed = JSON.parse(text); } catch { fail('INVALID_STATE_JSON', 'Catalog trust state entry is not valid JSON'); }
      const state = normalizeState(parsed);
      assert(fileName === stateFileName(state), 'STATE_FILE_BINDING_MISMATCH', 'Catalog trust state file name does not match its sequence and digest');
      return state;
    } finally {
      await handle.close();
    }
  }

  async read() {
    await this.#assertRoot();
    const entries = await fsp.readdir(this.#root, { withFileTypes: true });
    const stateEntries = entries.filter(entry => STATE_FILE.test(entry.name));
    for (const entry of stateEntries) {
      assert(entry.isFile(), 'UNSAFE_STATE_ENTRY', 'Catalog trust state entries must be regular files, never symlinks or directories');
    }
    const candidates = stateEntries
      .map(entry => ({ name: entry.name, match: entry.name.match(STATE_FILE) }))
      .map(entry => ({ name: entry.name, sequence: Number(entry.match[1]), digest: entry.match[2] }))
      .filter(entry => Number.isSafeInteger(entry.sequence) && entry.sequence > 0);
    if (!candidates.length) return null;
    const high = Math.max(...candidates.map(entry => entry.sequence));
    const highEntries = candidates.filter(entry => entry.sequence === high);
    assert(new Set(highEntries.map(entry => entry.digest)).size === 1, 'STATE_EQUIVOCATION_DETECTED', 'Multiple catalog digests exist at the trusted high-water sequence');
    assert(highEntries.length === 1, 'STATE_DUPLICATE_DETECTED', 'Catalog trust state contains duplicate high-water entries');
    return clone(await this.#readFile(highEntries[0].name));
  }

  async accept(input) {
    const state = normalizeState(input);
    await this.#assertRoot();
    const previous = await this.read();
    if (previous) {
      assert(state.sequence >= previous.sequence, 'STATE_ROLLBACK_DETECTED', 'Refusing to lower the persistent catalog high-water sequence');
      if (state.sequence === previous.sequence) {
        assert(sameSignedState(previous, state), 'STATE_EQUIVOCATION_DETECTED', 'Refusing different signed metadata at the existing catalog sequence');
        return clone(previous);
      }
    }

    const fileName = stateFileName(state);
    const filePath = path.join(this.#root, fileName);
    const payload = `${JSON.stringify(state)}\n`;
    let handle;
    try {
      handle = await fsp.open(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      await handle.writeFile(payload, { encoding: 'utf8' });
      await handle.sync();
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      if (handle) await handle.close();
    }
    const accepted = await this.read();
    assert(accepted, 'STATE_PERSISTENCE_FAILED', 'Catalog trust state high-water mark was not persisted');
    assert(accepted.sequence === state.sequence, 'STATE_STALE_ACCEPTANCE', 'A newer catalog sequence won concurrently; refusing authorization based on stale metadata');
    assert(sameSignedState(accepted, state), 'STATE_EQUIVOCATION_DETECTED', 'Concurrent catalog state acceptance detected equivocation');
    return clone(accepted);
  }
}

export function createProductionCatalogTrustStateStore({ stateRoot = '/var/lib/swir/security/catalog-trust' } = {}) {
  return new FileCatalogTrustStateStore({ stateRoot, expectedOwnerUid: 0 });
}

export const FileCatalogTrustStatePolicy = Object.freeze({
  schema: STATE_SCHEMA,
  catalogId: CATALOG_ID,
  productionStateRoot: '/var/lib/swir/security/catalog-trust',
  productionOwnerUid: 0,
  directoryMode: '0700',
  fileMode: '0600',
  appendOnlyHighWater: true,
  atomicCreate: true,
  failClosedOnMalformedState: true,
  failClosedOnEquivocation: true
});
