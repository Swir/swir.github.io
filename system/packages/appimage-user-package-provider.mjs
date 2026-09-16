import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const OPERATIONS = new Set(['install', 'update', 'remove']);
const PACKAGE_ID = /^[a-z0-9][a-z0-9._-]{1,127}$/i;
const SOURCE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(code, message) {
  const error = new Error(message);
  error.name = 'AppImageUserPackageProviderError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function defaultInstallRoot() {
  return path.join(os.homedir(), '.local', 'lib', 'swir', 'appimages');
}

function normalizeRoot(value) {
  const root = path.resolve(value || defaultInstallRoot());
  assert(path.isAbsolute(root), 'INVALID_INSTALL_ROOT', 'AppImage install root must be absolute');
  return root;
}

function targetFor(root, id) {
  return path.join(root, `${id}.AppImage`);
}

function validateOperation(operation) {
  assert(OPERATIONS.has(operation), 'UNSUPPORTED_OPERATION', 'Unsupported AppImage package operation');
  return operation;
}

export function validateAppImageManifest(manifest, { installRoot } = {}) {
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'INVALID_MANIFEST', 'Package manifest must be an object');
  assert(manifest.schema === 'swir.package-provider/0.2', 'UNSUPPORTED_SCHEMA', 'Unsupported package provider schema');
  assert(Array.isArray(manifest.targetEditions) && manifest.targetEditions.includes('system'), 'WRONG_EDITION', 'AppImage package must target System Edition');
  assert(manifest.executionClass === 'linux-native', 'WRONG_EXECUTION_CLASS', 'AppImage provider accepts linux-native packages only');
  assert(manifest.provider === 'swir.package.appimage', 'WRONG_PROVIDER', 'AppImage provider requires swir.package.appimage');
  assert(PACKAGE_ID.test(manifest.id || ''), 'INVALID_PACKAGE_ID', 'Invalid package id');
  assert(manifest.package && typeof manifest.package === 'object' && !Array.isArray(manifest.package), 'INVALID_PACKAGE', 'AppImage package metadata is required');
  assert(SOURCE_REF.test(manifest.package.sourceRef || ''), 'INVALID_SOURCE_REF', 'AppImage sourceRef must be an opaque artifact identifier');
  assert(manifest.package.scope === 'user', 'SYSTEM_SCOPE_NOT_SUPPORTED', 'AppImage provider 0.1 supports user scope only');
  assert(SHA256.test(manifest.package.sha256 || ''), 'INVALID_SHA256', 'AppImage package requires a lowercase SHA-256 digest');
  assert(manifest.trust?.sourceClass === 'swir-signed', 'WRONG_SOURCE_CLASS', 'AppImage provider requires swir-signed trust');
  assert(manifest.trust?.signatureRequired === true, 'SIGNATURE_REQUIRED', 'AppImage package signature verification must be required');
  const root = normalizeRoot(installRoot);
  const target = targetFor(root, manifest.id);
  assert(path.resolve(manifest.package.nativeEntryPoint || '') === target, 'ENTRY_POINT_MISMATCH', 'AppImage nativeEntryPoint must match the managed install target');
  return { root, target, sourceRef: manifest.package.sourceRef, sha256: manifest.package.sha256 };
}

export function buildAppImageUserPlan(operation, manifest, { installRoot } = {}) {
  validateOperation(operation);
  const checked = validateAppImageManifest(manifest, { installRoot });
  return Object.freeze({
    schema: 'swir.appimage-user-plan/0.1',
    provider: 'swir.package.appimage',
    executionClass: 'linux-native',
    operation,
    package: Object.freeze({ id: manifest.id, sourceRef: checked.sourceRef, sha256: checked.sha256, scope: 'user', target: checked.target }),
    trust: Object.freeze({ sourceClass: 'swir-signed', signatureVerificationRequired: true, digestVerificationRequired: true, arbitraryDownloadUrlAllowed: false }),
    transaction: Object.freeze({ requiresPrivilege: false, shellAllowed: false, journalRequired: true, atomicReplace: true, rollback: Object.freeze({ supported: true, mechanism: 'managed-file-backup' }) }),
    sandbox: Object.freeze({ formatProvidesSandbox: false, executionMustRemainBehindSwirPermissions: true })
  });
}

export function validateAppImageUserPlan(plan, { installRoot } = {}) {
  assert(plan && typeof plan === 'object' && !Array.isArray(plan), 'INVALID_PLAN', 'AppImage plan must be an object');
  assert(plan.schema === 'swir.appimage-user-plan/0.1', 'INVALID_PLAN_SCHEMA', 'Unsupported AppImage plan schema');
  assert(plan.provider === 'swir.package.appimage', 'INVALID_PLAN_PROVIDER', 'AppImage plan provider mismatch');
  validateOperation(plan.operation);
  assert(PACKAGE_ID.test(plan.package?.id || ''), 'INVALID_PACKAGE_ID', 'Invalid package id');
  assert(SOURCE_REF.test(plan.package?.sourceRef || ''), 'INVALID_SOURCE_REF', 'Invalid AppImage sourceRef');
  assert(SHA256.test(plan.package?.sha256 || ''), 'INVALID_SHA256', 'Invalid AppImage SHA-256');
  assert(plan.package?.scope === 'user', 'INVALID_PLAN_SCOPE', 'AppImage plan must remain user scoped');
  const root = normalizeRoot(installRoot);
  assert(path.resolve(plan.package?.target || '') === targetFor(root, plan.package.id), 'TARGET_POLICY_VIOLATION', 'AppImage target escaped the managed install root');
  assert(plan.trust?.signatureVerificationRequired === true, 'SIGNATURE_REQUIRED', 'AppImage plan must require signature verification');
  assert(plan.trust?.digestVerificationRequired === true, 'DIGEST_REQUIRED', 'AppImage plan must require digest verification');
  assert(plan.trust?.arbitraryDownloadUrlAllowed === false, 'DOWNLOAD_POLICY_VIOLATION', 'AppImage plan cannot allow arbitrary download URLs');
  assert(plan.transaction?.requiresPrivilege === false, 'PRIVILEGE_POLICY_VIOLATION', 'AppImage user plan cannot request privilege');
  assert(plan.transaction?.shellAllowed === false, 'SHELL_POLICY_VIOLATION', 'AppImage user plan cannot enable shell execution');
  assert(plan.transaction?.journalRequired === true, 'JOURNAL_REQUIRED', 'AppImage plan must require a transaction journal');
  assert(plan.sandbox?.formatProvidesSandbox === false, 'SANDBOX_POLICY_INVALID', 'AppImage must not be represented as intrinsically sandboxed');
  return plan;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.promises.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(temp, file);
}

export class ManagedAppImageUserExecutor {
  #root;

  constructor({ installRoot } = {}) {
    this.#root = normalizeRoot(installRoot);
  }

  async execute(plan, context = {}) {
    validateAppImageUserPlan(plan, { installRoot: this.#root });
    assert(context.signatureVerified === true, 'SIGNATURE_NOT_VERIFIED', 'Verified SWIR signature evidence is required before AppImage mutation');
    await fs.promises.mkdir(this.#root, { recursive: true, mode: 0o700 });
    const journalRoot = path.join(this.#root, '.transactions');
    const rollbackRoot = path.join(this.#root, '.rollback');
    await fs.promises.mkdir(journalRoot, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(rollbackRoot, { recursive: true, mode: 0o700 });

    const target = plan.package.target;
    const exists = await fs.promises.stat(target).then(s => s.isFile(), () => false);
    if (plan.operation === 'install') assert(!exists, 'ALREADY_INSTALLED', 'AppImage is already installed');
    if (plan.operation !== 'install') assert(exists, 'NOT_INSTALLED', 'AppImage is not installed');

    let artifact = null;
    if (plan.operation !== 'remove') {
      assert(typeof context.artifactPath === 'string' && path.isAbsolute(context.artifactPath), 'ARTIFACT_REQUIRED', 'Install/update requires an absolute local artifactPath');
      artifact = await fs.promises.realpath(context.artifactPath);
      const stat = await fs.promises.stat(artifact);
      assert(stat.isFile(), 'INVALID_ARTIFACT', 'AppImage artifact must be a regular file');
      const digest = await sha256File(artifact);
      assert(digest === plan.package.sha256, 'DIGEST_MISMATCH', 'AppImage artifact SHA-256 does not match signed metadata');
    }

    const txnId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const backup = path.join(rollbackRoot, `${plan.package.id}-${txnId}.AppImage`);
    const temp = path.join(this.#root, `.${plan.package.id}-${txnId}.tmp`);
    const journalFile = path.join(journalRoot, `${txnId}.json`);
    const journal = { schema: 'swir.appimage-transaction/0.1', id: txnId, packageId: plan.package.id, operation: plan.operation, target, backup: exists ? backup : null, temp: plan.operation === 'remove' ? null : temp, state: 'prepared' };
    await writeJsonAtomic(journalFile, journal);

    try {
      if (exists) await fs.promises.rename(target, backup);
      if (plan.operation !== 'remove') {
        await fs.promises.copyFile(artifact, temp, fs.constants.COPYFILE_EXCL);
        await fs.promises.chmod(temp, 0o700);
        const copiedDigest = await sha256File(temp);
        assert(copiedDigest === plan.package.sha256, 'COPIED_DIGEST_MISMATCH', 'Copied AppImage failed post-copy integrity verification');
        await fs.promises.rename(temp, target);
      }
      journal.state = 'committed';
      journal.rollbackAvailable = exists || plan.operation === 'install';
      await writeJsonAtomic(journalFile, journal);
      return Object.freeze({ schema: 'swir.appimage-user-result/0.1', provider: 'swir.package.appimage', operation: plan.operation, packageId: plan.package.id, state: 'committed', target, rollbackAvailable: journal.rollbackAvailable, transactionId: txnId });
    } catch (error) {
      await fs.promises.rm(temp, { force: true }).catch(() => {});
      const backupExists = await fs.promises.stat(backup).then(s => s.isFile(), () => false);
      if (backupExists) {
        await fs.promises.rm(target, { force: true }).catch(() => {});
        await fs.promises.rename(backup, target).catch(() => {});
      }
      journal.state = 'recovered-after-error';
      journal.error = error?.code || error?.message || 'unknown';
      await writeJsonAtomic(journalFile, journal).catch(() => {});
      throw error;
    }
  }

  async recoverPending() {
    const journalRoot = path.join(this.#root, '.transactions');
    const entries = await fs.promises.readdir(journalRoot, { withFileTypes: true }).catch(() => []);
    const recovered = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(journalRoot, entry.name);
      const journal = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      if (journal.schema !== 'swir.appimage-transaction/0.1' || journal.state !== 'prepared') continue;
      if (journal.temp) await fs.promises.rm(journal.temp, { force: true }).catch(() => {});
      const backupExists = journal.backup ? await fs.promises.stat(journal.backup).then(s => s.isFile(), () => false) : false;
      const targetExists = await fs.promises.stat(journal.target).then(s => s.isFile(), () => false);
      if (backupExists) {
        if (targetExists) await fs.promises.rm(journal.target, { force: true });
        await fs.promises.rename(journal.backup, journal.target);
      } else if (journal.operation === 'install' && targetExists) {
        await fs.promises.rm(journal.target, { force: true });
      }
      journal.state = 'recovered';
      await writeJsonAtomic(file, journal);
      recovered.push({ id: journal.id, packageId: journal.packageId, state: 'recovered' });
    }
    return recovered;
  }
}

export class AppImageUserPackageAdapter {
  #root;
  #executor;

  constructor({ installRoot, executor } = {}) {
    this.#root = normalizeRoot(installRoot);
    this.#executor = executor || new ManagedAppImageUserExecutor({ installRoot: this.#root });
    assert(this.#executor && typeof this.#executor.execute === 'function', 'INVALID_EXECUTOR', 'AppImage executor must expose execute()');
  }

  describe() {
    return Object.freeze({ schema: 'swir.package-provider-adapter/0.1', provider: 'swir.package.appimage', kind: 'appimage', available: true, scope: 'user', installRoot: this.#root, privilegedMutation: false, arbitraryDownloadUrlAllowed: false, signatureVerificationRequired: true, digestVerificationRequired: true, formatProvidesSandbox: false });
  }

  plan(operation, manifest) {
    return buildAppImageUserPlan(operation, clone(manifest), { installRoot: this.#root });
  }

  async execute(operation, manifest, context = {}) {
    return this.#executor.execute(this.plan(operation, manifest), clone(context));
  }

  async recoverPending() {
    return this.#executor.recoverPending ? this.#executor.recoverPending() : [];
  }
}

export function createAppImageUserPackageAdapter({ installRoot } = {}) {
  return new AppImageUserPackageAdapter({ installRoot });
}

export const AppImageUserPackagePolicy = Object.freeze({ schema: 'swir.appimage-user-plan/0.1', provider: 'swir.package.appimage', executionClass: 'linux-native', scope: 'user', arbitraryDownloadUrls: false, signatureVerificationRequired: true, digestVerificationRequired: true, shellAllowed: false, privilegedMutation: false, journalRequired: true, atomicReplace: true, rollbackImplemented: true, formatProvidesSandbox: false });
