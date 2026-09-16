import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_MANAGERS = new Set(['apt', 'dnf', 'rpm-ostree', 'pacman', 'zypper']);
const OPERATIONS = new Set(['install', 'update', 'remove']);
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9+._:@-]{0,127}$/;
const TRANSACTION_ID = /^[A-Za-z0-9._-]{8,128}$/;
const ACTIVE_STATES = new Set(['prepared', 'mutating', 'verifying', 'rolling-back']);
const TERMINAL_STATES = new Set(['committed', 'rolled-back', 'aborted', 'failed-needs-recovery']);
const MAX_JOURNAL_BYTES = 1024 * 1024;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, message, cause) {
  throw new PackageTransactionError(code, message, cause);
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(value => typeof value === 'string' && value.length > 0))];
}

function expectedSnapshotSource(manager) {
  if (manager === 'apt') return 'dpkg-query';
  if (manager === 'pacman') return 'pacman';
  return 'rpm';
}

export class PackageTransactionError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PackageTransactionError';
    this.code = code;
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function digestPackagePlan(plan) {
  return crypto.createHash('sha256').update(stableStringify(plan), 'utf8').digest('hex');
}

export function expectedPackageManagerCommand(manager, operation, packageName) {
  assert(SUPPORTED_MANAGERS.has(manager), 'UNSUPPORTED_PACKAGE_MANAGER', 'unsupported distribution package manager');
  assert(OPERATIONS.has(operation), 'UNSUPPORTED_OPERATION', 'unsupported package operation');
  assert(typeof packageName === 'string' && PACKAGE_NAME.test(packageName), 'INVALID_PACKAGE_NAME', 'invalid package sourceRef');

  if (manager === 'apt') {
    if (operation === 'install') return ['apt-get', 'install', '--', packageName];
    if (operation === 'update') return ['apt-get', 'install', '--only-upgrade', '--', packageName];
    return ['apt-get', 'remove', '--', packageName];
  }
  if (manager === 'dnf') return ['dnf', operation === 'update' ? 'upgrade' : operation, '--', packageName];
  if (manager === 'rpm-ostree') {
    if (operation === 'install') return ['rpm-ostree', 'install', '--', packageName];
    if (operation === 'update') return ['rpm-ostree', 'upgrade'];
    return ['rpm-ostree', 'uninstall', '--', packageName];
  }
  if (manager === 'pacman') {
    if (operation === 'install') return ['pacman', '-S', '--', packageName];
    if (operation === 'update') return ['pacman', '-S', '--needed', '--', packageName];
    return ['pacman', '-R', '--', packageName];
  }
  if (manager === 'zypper') {
    if (operation === 'install') return ['zypper', '--non-interactive', 'install', '--', packageName];
    if (operation === 'update') return ['zypper', '--non-interactive', 'update', '--', packageName];
    return ['zypper', '--non-interactive', 'remove', '--', packageName];
  }
  fail('UNSUPPORTED_PACKAGE_MANAGER', 'unsupported distribution package manager');
}

export function validatePrivilegedCommand({ manager, operation, packageName, command }) {
  assert(Array.isArray(command) && command.length > 0, 'INVALID_COMMAND', 'package transaction command must be a non-empty array');
  assert(command.every(value => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value)), 'INVALID_COMMAND', 'package transaction command contains invalid arguments');
  const expected = expectedPackageManagerCommand(manager, operation, packageName);
  assert(stableStringify(command) === stableStringify(expected), 'COMMAND_MISMATCH', 'package transaction command does not match the trusted provider plan');
  return expected;
}

export function validatePackageSnapshot(snapshot, { manager, packageName, packageId }) {
  assert(isObject(snapshot), 'SNAPSHOT_REQUIRED', 'package transaction snapshot provider must return an object');
  assert(snapshot.schema === 'swir.package-snapshot/0.1', 'INVALID_SNAPSHOT_SCHEMA', 'package snapshot schema mismatch');
  assert(typeof snapshot.capturedAt === 'string' && snapshot.capturedAt.length > 0, 'INVALID_SNAPSHOT', 'package snapshot requires capturedAt');
  assert(snapshot.packageId === packageId, 'SNAPSHOT_PACKAGE_MISMATCH', 'package snapshot package id does not match transaction plan');
  assert(snapshot.manager === manager, 'SNAPSHOT_MANAGER_MISMATCH', 'package snapshot manager does not match transaction plan');
  assert(snapshot.packageName === packageName, 'SNAPSHOT_PACKAGE_MISMATCH', 'package snapshot package name does not match transaction plan');
  assert(typeof snapshot.installed === 'boolean', 'INVALID_SNAPSHOT', 'package snapshot installed flag must be boolean');
  if (snapshot.installed) {
    assert(typeof snapshot.version === 'string' && snapshot.version.length > 0, 'INVALID_SNAPSHOT_VERSION', 'installed package snapshot requires a version');
  } else {
    assert(snapshot.version === null, 'INVALID_SNAPSHOT_VERSION', 'non-installed package snapshot must use null version');
  }
  assert(isObject(snapshot.query), 'INVALID_SNAPSHOT', 'package snapshot requires query metadata');
  assert(snapshot.query.source === expectedSnapshotSource(manager), 'SNAPSHOT_SOURCE_MISMATCH', 'package snapshot query source does not match package manager');
  assert(Number.isInteger(snapshot.query.exitCode), 'INVALID_SNAPSHOT', 'package snapshot query requires integer exit code');
  assert(snapshot.query.signal === null || typeof snapshot.query.signal === 'string', 'INVALID_SNAPSHOT', 'package snapshot query signal must be string or null');
  return snapshot;
}

export function validatePackageHealth(health, { packageName, packageId }) {
  assert(isObject(health), 'HEALTH_RESULT_REQUIRED', 'package health verifier must return an object');
  assert(health.schema === 'swir.package-health/0.1', 'INVALID_HEALTH_SCHEMA', 'package health schema mismatch');
  assert(health.packageId === packageId, 'HEALTH_PACKAGE_MISMATCH', 'package health package id does not match transaction plan');
  assert(health.packageName === packageName, 'HEALTH_PACKAGE_MISMATCH', 'package health package name does not match transaction plan');
  assert(typeof health.healthy === 'boolean', 'INVALID_HEALTH_RESULT', 'package health result must include boolean healthy');
  assert(Array.isArray(health.checks) && health.checks.length > 0, 'INVALID_HEALTH_RESULT', 'package health result must include checks');
  for (const check of health.checks) {
    assert(isObject(check), 'INVALID_HEALTH_CHECK', 'package health check must be an object');
    assert(typeof check.id === 'string' && check.id.length > 0, 'INVALID_HEALTH_CHECK', 'package health check requires id');
    assert(typeof check.ok === 'boolean', 'INVALID_HEALTH_CHECK', 'package health check requires boolean ok');
    if (Object.prototype.hasOwnProperty.call(check, 'reason')) assert(typeof check.reason === 'string' && check.reason.length > 0, 'INVALID_HEALTH_CHECK', 'package health check reason must be non-empty string');
    if (Object.prototype.hasOwnProperty.call(check, 'resolved')) assert(typeof check.resolved === 'string' && check.resolved.length > 0, 'INVALID_HEALTH_CHECK', 'package health check resolved path must be non-empty string');
  }
  return health;
}

export function validateSystemPackagePlan(plan, { allowlistedRepositories = [] } = {}) {
  assert(isObject(plan), 'INVALID_PLAN', 'package transaction plan must be an object');
  assert(plan.schema === 'swir.system-package-plan/0.1', 'INVALID_PLAN_SCHEMA', 'unsupported system package plan schema');
  assert(plan.mode === 'preview' && plan.readOnly === true && plan.autoExecutable === false, 'UNSAFE_PLAN_MODE', 'system package plan must remain preview/read-only/non-executable');
  assert(plan.provider === 'swir.package.system', 'INVALID_PROVIDER', 'system package transaction requires swir.package.system');
  assert(plan.executionClass === 'linux-native', 'INVALID_EXECUTION_CLASS', 'system package transaction accepts linux-native plans only');
  assert(OPERATIONS.has(plan.operation), 'UNSUPPORTED_OPERATION', 'unsupported package operation');

  assert(isObject(plan.package), 'INVALID_PLAN', 'package transaction plan is missing package metadata');
  assert(typeof plan.package.id === 'string' && plan.package.id.length > 0, 'INVALID_PACKAGE_ID', 'package transaction plan requires package id');
  assert(typeof plan.package.sourceRef === 'string' && PACKAGE_NAME.test(plan.package.sourceRef), 'INVALID_PACKAGE_NAME', 'invalid package sourceRef');

  assert(isObject(plan.host), 'INVALID_PLAN', 'package transaction plan is missing host metadata');
  assert(SUPPORTED_MANAGERS.has(plan.host.packageManager), 'UNSUPPORTED_PACKAGE_MANAGER', 'unsupported package manager in transaction plan');
  assert(Array.isArray(plan.host.availablePackageManagers) && plan.host.availablePackageManagers.includes(plan.host.packageManager), 'PACKAGE_MANAGER_UNAVAILABLE', 'selected package manager is not reported available on host');

  assert(isObject(plan.source) && plan.source.class === 'distribution-repository', 'UNTRUSTED_SOURCE_CLASS', 'system package transaction requires distribution-repository source');
  const repositoryId = plan.source.repositoryId;
  assert(repositoryId === null || (typeof repositoryId === 'string' && repositoryId.length > 0), 'INVALID_REPOSITORY_ID', 'invalid distribution repository id');
  if (repositoryId !== null) {
    const allowed = new Set(uniqueStrings(allowlistedRepositories));
    assert(allowed.has(repositoryId), 'REPOSITORY_NOT_ALLOWLISTED', 'distribution repository is not allowlisted for privileged mutation');
  }

  assert(isObject(plan.trust), 'INVALID_PLAN', 'package transaction plan is missing trust policy');
  assert(plan.trust.signatureVerificationRequired === true, 'SIGNATURE_VERIFICATION_REQUIRED', 'repository signature verification must remain required');
  assert(plan.trust.arbitraryRepositoryUrlAllowed === false, 'ARBITRARY_REPOSITORY_URL_FORBIDDEN', 'arbitrary repository URLs must remain disabled');

  assert(isObject(plan.transaction), 'INVALID_PLAN', 'package transaction plan is missing transaction policy');
  assert(plan.transaction.requiresPrivilege === true, 'PRIVILEGE_REQUIRED', 'package mutation must require privilege');
  assert(plan.transaction.journalRequired === true, 'JOURNAL_REQUIRED', 'package mutation must require a durable journal');
  assert(typeof plan.transaction.healthCheckRequired === 'boolean', 'INVALID_PLAN', 'healthCheckRequired must be boolean');
  assert(isObject(plan.transaction.rollback), 'INVALID_PLAN', 'package transaction plan is missing rollback policy');

  const command = validatePrivilegedCommand({
    manager: plan.host.packageManager,
    operation: plan.operation,
    packageName: plan.package.sourceRef,
    command: plan.commandPreview
  });

  if (plan.transaction.rollback.supported === true) {
    assert(plan.host.packageManager === 'rpm-ostree' && plan.transaction.rollback.mechanism === 'deployment-rollback', 'UNSUPPORTED_ROLLBACK_POLICY', 'automatic rollback is currently limited to rpm-ostree deployment rollback');
  }

  return {
    manager: plan.host.packageManager,
    operation: plan.operation,
    packageName: plan.package.sourceRef,
    repositoryId,
    command,
    planDigest: digestPackagePlan(plan)
  };
}

function rollbackCommandFor(plan) {
  if (plan?.transaction?.rollback?.supported === true && plan?.host?.packageManager === 'rpm-ostree' && plan?.transaction?.rollback?.mechanism === 'deployment-rollback') {
    return ['rpm-ostree', 'rollback'];
  }
  return null;
}

function ensureJournalDirectory(journalDirectory) {
  fs.mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(journalDirectory);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_JOURNAL_DIRECTORY', 'package journal path must be a real directory');
  if (Number.isInteger(stat.mode)) assert((stat.mode & 0o022) === 0, 'UNSAFE_JOURNAL_DIRECTORY_MODE', 'package journal directory must not be group/world writable');
}

function atomicWriteJson(directory, id, value) {
  assert(typeof id === 'string' && TRANSACTION_ID.test(id), 'INVALID_TRANSACTION_ID', 'transaction id contains unsafe characters');
  ensureJournalDirectory(directory);
  const target = path.join(directory, `${id}.json`);
  const temporary = path.join(directory, `.${id}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const data = `${JSON.stringify(value, null, 2)}\n`;
  assert(Buffer.byteLength(data) <= MAX_JOURNAL_BYTES, 'JOURNAL_TOO_LARGE', 'package transaction journal exceeds size limit');
  fs.writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const file = fs.openSync(temporary, 'r');
  try { fs.fsyncSync(file); } finally { fs.closeSync(file); }
  fs.renameSync(temporary, target);
  try {
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch {
    // Directory fsync is not available on every host/filesystem. File fsync + atomic rename still applies.
  }
  return target;
}

function readJournalFile(filePath) {
  const stat = fs.lstatSync(filePath);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'UNSAFE_JOURNAL_FILE', 'package transaction journal must be a regular file');
  if (Number.isInteger(stat.mode)) assert((stat.mode & 0o022) === 0, 'UNSAFE_JOURNAL_FILE_MODE', 'package transaction journal must not be group/world writable');
  assert(stat.size <= MAX_JOURNAL_BYTES, 'JOURNAL_TOO_LARGE', 'package transaction journal exceeds size limit');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert(parsed?.schema === 'swir.system-package-transaction/0.1', 'INVALID_JOURNAL_SCHEMA', 'unsupported package transaction journal schema');
  assert(typeof parsed.id === 'string' && TRANSACTION_ID.test(parsed.id), 'INVALID_JOURNAL', 'package transaction journal requires a safe transaction id');
  assert(path.basename(filePath) === `${parsed.id}.json`, 'JOURNAL_ID_PATH_MISMATCH', 'package transaction journal id does not match file name');
  assert(isObject(parsed.plan), 'INVALID_JOURNAL', 'package transaction journal requires original plan');
  assert(parsed.planDigest === digestPackagePlan(parsed.plan), 'JOURNAL_PLAN_DIGEST_MISMATCH', 'package transaction journal plan digest mismatch');
  assert(ACTIVE_STATES.has(parsed.state) || TERMINAL_STATES.has(parsed.state), 'INVALID_JOURNAL_STATE', 'invalid package transaction journal state');
  return parsed;
}

function appendState(record, state, now, detail = null) {
  const next = clone(record);
  next.state = state;
  next.sequence = Number.isInteger(next.sequence) ? next.sequence + 1 : 1;
  next.updatedAt = now;
  next.history = Array.isArray(next.history) ? next.history : [];
  next.history.push({ state, at: now, detail });
  return next;
}

function safeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'PACKAGE_TRANSACTION_FAILED',
    message: typeof error?.message === 'string' ? error.message.slice(0, 500) : 'Package transaction failed'
  };
}

function requireDependency(value, method, name) {
  assert(value && typeof value[method] === 'function', 'MISSING_DEPENDENCY', `${name}.${method} is required`);
}

export class SystemPackageTransactionService {
  #journalDirectory;
  #executor;
  #authorizationBroker;
  #trustVerifier;
  #snapshotProvider;
  #healthVerifier;
  #allowlistedRepositories;
  #clock;
  #idFactory;

  constructor({
    journalDirectory,
    executor,
    authorizationBroker,
    trustVerifier,
    snapshotProvider,
    healthVerifier,
    allowlistedRepositories = [],
    clock = () => new Date().toISOString(),
    idFactory = () => crypto.randomUUID()
  } = {}) {
    assert(typeof journalDirectory === 'string' && path.isAbsolute(journalDirectory), 'INVALID_JOURNAL_DIRECTORY', 'package transaction journalDirectory must be absolute');
    requireDependency(executor, 'execute', 'executor');
    requireDependency(authorizationBroker, 'authorize', 'authorizationBroker');
    requireDependency(trustVerifier, 'verifyRepository', 'trustVerifier');
    requireDependency(snapshotProvider, 'capture', 'snapshotProvider');
    requireDependency(healthVerifier, 'verify', 'healthVerifier');
    this.#journalDirectory = journalDirectory;
    this.#executor = executor;
    this.#authorizationBroker = authorizationBroker;
    this.#trustVerifier = trustVerifier;
    this.#snapshotProvider = snapshotProvider;
    this.#healthVerifier = healthVerifier;
    this.#allowlistedRepositories = uniqueStrings(allowlistedRepositories);
    this.#clock = clock;
    this.#idFactory = idFactory;
    ensureJournalDirectory(journalDirectory);
  }

  async execute(plan, context = {}) {
    const validated = validateSystemPackagePlan(plan, { allowlistedRepositories: this.#allowlistedRepositories });
    const trust = await this.#trustVerifier.verifyRepository({
      repositoryId: validated.repositoryId,
      manager: validated.manager,
      distribution: clone(plan.host.distribution || {}),
      packageName: validated.packageName,
      operation: validated.operation,
      signatureRequired: true
    });
    assert(trust?.verified === true, 'REPOSITORY_TRUST_NOT_VERIFIED', 'distribution repository trust verification failed');

    const authorization = await this.#authorize('packages.mutate', validated.planDigest, plan, context);
    const snapshot = validatePackageSnapshot(await this.#snapshotProvider.capture({
      manager: validated.manager,
      operation: validated.operation,
      packageName: validated.packageName,
      packageId: plan.package.id
    }), {
      manager: validated.manager,
      packageName: validated.packageName,
      packageId: plan.package.id
    });

    const id = this.#idFactory();
    assert(typeof id === 'string' && TRANSACTION_ID.test(id), 'INVALID_TRANSACTION_ID', 'transaction id contains unsafe characters');
    const now = this.#clock();
    let record = {
      schema: 'swir.system-package-transaction/0.1',
      id,
      state: 'prepared',
      sequence: 1,
      createdAt: now,
      updatedAt: now,
      planDigest: validated.planDigest,
      plan: clone(plan),
      trust: {
        verified: true,
        proofId: typeof trust.proofId === 'string' ? trust.proofId : null,
        repositoryId: validated.repositoryId
      },
      authorization: {
        grantId: authorization.grantId,
        actorId: authorization.actorId,
        scope: 'packages.mutate'
      },
      snapshot: clone(snapshot),
      execution: null,
      health: null,
      recovery: { automaticRollbackAvailable: Boolean(rollbackCommandFor(plan)), rollbackCommand: rollbackCommandFor(plan) },
      error: null,
      history: [{ state: 'prepared', at: now, detail: 'trust, authorization and pre-mutation snapshot captured' }]
    };
    atomicWriteJson(this.#journalDirectory, id, record);

    let mutationStarted = false;
    try {
      record = this.#transition(record, 'mutating', 'privileged package executor handoff');
      mutationStarted = true;
      const execution = await this.#executor.execute({
        schema: 'swir.package-executor-request/0.1',
        transactionId: id,
        planDigest: validated.planDigest,
        manager: validated.manager,
        operation: validated.operation,
        packageName: validated.packageName,
        command: validated.command
      });
      record.execution = clone(execution || { ok: true });
      atomicWriteJson(this.#journalDirectory, id, record);

      if (plan.transaction.healthCheckRequired) {
        record = this.#transition(record, 'verifying', 'post-mutation health verification');
        const health = validatePackageHealth(await this.#healthVerifier.verify({
          transactionId: id,
          packageId: plan.package.id,
          packageName: validated.packageName,
          nativeEntryPoint: plan.package.nativeEntryPoint,
          operation: validated.operation,
          manager: validated.manager
        }), {
          packageId: plan.package.id,
          packageName: validated.packageName
        });
        record.health = clone(health);
        atomicWriteJson(this.#journalDirectory, id, record);
        assert(health.healthy === true, 'HEALTH_CHECK_FAILED', 'post-mutation package health check failed');
      }

      record = this.#transition(record, 'committed', 'package transaction committed');
      return clone(record);
    } catch (error) {
      if (!mutationStarted) {
        record.error = safeError(error);
        record = this.#transition(record, 'aborted', 'transaction failed before privileged mutation');
        throw new PackageTransactionError(error?.code || 'PACKAGE_TRANSACTION_ABORTED', error?.message || 'package transaction aborted', error);
      }
      return this.#rollbackAfterFailure(record, error, validated);
    }
  }

  async recoverPending(context = {}) {
    ensureJournalDirectory(this.#journalDirectory);
    const outcomes = [];
    const files = fs.readdirSync(this.#journalDirectory)
      .filter(name => /^[A-Za-z0-9._-]{8,128}\.json$/.test(name))
      .sort();

    for (const name of files) {
      const filePath = path.join(this.#journalDirectory, name);
      let record;
      try {
        record = readJournalFile(filePath);
      } catch (error) {
        outcomes.push({ id: name.replace(/\.json$/, ''), status: 'corrupt', error: safeError(error) });
        continue;
      }
      if (!ACTIVE_STATES.has(record.state)) continue;

      let validated;
      try {
        validated = validateSystemPackagePlan(record.plan, { allowlistedRepositories: this.#allowlistedRepositories });
        validatePackageSnapshot(record.snapshot, {
          manager: validated.manager,
          packageName: validated.packageName,
          packageId: record.plan.package.id
        });
        if (record.health !== null) {
          validatePackageHealth(record.health, {
            packageName: validated.packageName,
            packageId: record.plan.package.id
          });
        }
      } catch (error) {
        outcomes.push({ id: record.id, status: 'blocked', error: safeError(error) });
        continue;
      }

      const rollback = rollbackCommandFor(record.plan);
      if (!rollback) {
        record.error = { code: 'RECOVERY_REQUIRES_MANUAL_INTERVENTION', message: 'No verified automatic rollback mechanism is available for this package manager.' };
        record = this.#transition(record, 'failed-needs-recovery', 'automatic crash recovery is unavailable');
        outcomes.push({ id: record.id, status: record.state });
        continue;
      }

      try {
        await this.#authorize('packages.recover', validated.planDigest, record.plan, context);
        record = this.#transition(record, 'rolling-back', 'crash recovery rollback authorized');
        await this.#executeRollback(record, validated, rollback);
        record = this.#transition(record, 'rolled-back', 'crash recovery rollback completed');
        outcomes.push({ id: record.id, status: record.state });
      } catch (error) {
        record.error = safeError(error);
        record = this.#transition(record, 'failed-needs-recovery', 'crash recovery rollback failed');
        outcomes.push({ id: record.id, status: record.state, error: record.error });
      }
    }
    return outcomes;
  }

  readJournal(id) {
    assert(typeof id === 'string' && TRANSACTION_ID.test(id), 'INVALID_TRANSACTION_ID', 'invalid transaction id');
    return clone(readJournalFile(path.join(this.#journalDirectory, `${id}.json`)));
  }

  async #authorize(scope, planDigest, plan, context) {
    const result = await this.#authorizationBroker.authorize({
      schema: 'swir.system-authorization-request/0.1',
      scope,
      planDigest,
      packageId: plan.package.id,
      operation: plan.operation,
      context: clone(context || {})
    });
    assert(result?.authorized === true, 'AUTHORIZATION_DENIED', `authorization denied for ${scope}`);
    assert(typeof result.grantId === 'string' && result.grantId.length > 0, 'INVALID_AUTHORIZATION_GRANT', 'authorization broker must return grantId');
    assert(typeof result.actorId === 'string' && result.actorId.length > 0, 'INVALID_AUTHORIZATION_GRANT', 'authorization broker must bind grant to actorId');
    return result;
  }

  #transition(record, state, detail) {
    const next = appendState(record, state, this.#clock(), detail);
    atomicWriteJson(this.#journalDirectory, next.id, next);
    return next;
  }

  async #rollbackAfterFailure(record, error, validated) {
    record.error = safeError(error);
    const rollback = rollbackCommandFor(record.plan);
    if (!rollback) {
      record = this.#transition(record, 'failed-needs-recovery', 'mutation failed and no verified automatic rollback mechanism exists');
      throw new PackageTransactionError(error?.code || 'PACKAGE_TRANSACTION_FAILED_NEEDS_RECOVERY', `${error?.message || 'package transaction failed'}; manual recovery required`, error);
    }

    try {
      record = this.#transition(record, 'rolling-back', `automatic rollback after ${record.error.code}`);
      await this.#executeRollback(record, validated, rollback);
      record = this.#transition(record, 'rolled-back', 'automatic rollback completed');
      throw new PackageTransactionError(error?.code || 'PACKAGE_TRANSACTION_ROLLED_BACK', `${error?.message || 'package transaction failed'}; rollback completed`, error);
    } catch (rollbackError) {
      if (rollbackError instanceof PackageTransactionError && rollbackError.cause === error) throw rollbackError;
      record.error = { code: 'ROLLBACK_FAILED', message: `${error?.message || 'package transaction failed'}; rollback failed: ${rollbackError?.message || 'unknown rollback error'}`.slice(0, 500) };
      record = this.#transition(record, 'failed-needs-recovery', 'automatic rollback failed');
      throw new PackageTransactionError('ROLLBACK_FAILED', record.error.message, rollbackError);
    }
  }

  async #executeRollback(record, validated, rollbackCommand) {
    assert(stableStringify(rollbackCommand) === stableStringify(['rpm-ostree', 'rollback']), 'UNSAFE_ROLLBACK_COMMAND', 'untrusted rollback command rejected');
    return this.#executor.execute({
      schema: 'swir.package-executor-request/0.1',
      transactionId: record.id,
      planDigest: validated.planDigest,
      manager: 'rpm-ostree',
      operation: 'rollback',
      packageName: validated.packageName,
      command: rollbackCommand
    });
  }
}

export const SystemPackageTransactionPolicy = Object.freeze({
  schema: 'swir.system-package-transaction/0.1',
  supportedManagers: [...SUPPORTED_MANAGERS],
  sourceClass: 'distribution-repository',
  repositorySignatureVerificationRequired: true,
  allowlistedRepositoriesOnly: true,
  arbitraryRepositoryUrls: false,
  shellExecution: false,
  durableJournalRequiredBeforeMutation: true,
  journalDirectoryMustNotBeGroupWorldWritable: true,
  journalIdBoundToFilename: true,
  snapshotBindingRequired: true,
  healthBindingRequired: true,
  authorizationScope: 'packages.mutate',
  recoveryAuthorizationScope: 'packages.recover',
  automaticRollbackManagers: ['rpm-ostree']
});
