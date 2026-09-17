import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const OPERATIONS = new Set(['install', 'update', 'remove']);
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,255}$/;
const REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FLATPAK_BINARY = '/usr/bin/flatpak';
const MAX_OUTPUT_BYTES = 1024 * 1024;

function fail(code, message) {
  const error = new Error(message);
  error.name = 'FlatpakUserPackageProviderError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(value => typeof value === 'string' && value.length > 0))];
}

function validateOperation(operation) {
  assert(OPERATIONS.has(operation), 'UNSUPPORTED_OPERATION', 'Unsupported Flatpak package operation');
  return operation;
}

function validateAppId(value) {
  assert(typeof value === 'string' && APP_ID.test(value), 'INVALID_APP_ID', 'Flatpak sourceRef must be an application ID');
  return value;
}

function validateRemoteId(value) {
  assert(typeof value === 'string' && REMOTE_ID.test(value), 'INVALID_REMOTE_ID', 'Flatpak remote identifier is invalid');
  return value;
}

function defaultFileProbe(filePath) {
  const stat = fs.lstatSync(filePath);
  return {
    isFile: stat.isFile(),
    isSymbolicLink: stat.isSymbolicLink(),
    uid: stat.uid,
    mode: stat.mode,
    realpath: fs.realpathSync(filePath)
  };
}

function runtimeOptions(timeoutMs) {
  return {
    shell: false,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' })
  };
}

function verifyFlatpakBinary(fileProbe) {
  let state;
  try {
    state = fileProbe(FLATPAK_BINARY);
  } catch (error) {
    fail('FLATPAK_BINARY_UNAVAILABLE', `Trusted Flatpak executable is unavailable: ${error?.message || 'unknown error'}`);
  }
  assert(state && state.isFile === true && state.isSymbolicLink !== true, 'FLATPAK_BINARY_UNTRUSTED', 'Flatpak executable must be a regular non-symlink file');
  assert(state.uid === 0, 'FLATPAK_BINARY_UNTRUSTED', 'Flatpak executable must be root-owned');
  assert(Number.isInteger(state.mode) && (state.mode & 0o111) !== 0 && (state.mode & 0o022) === 0, 'FLATPAK_BINARY_UNTRUSTED', 'Flatpak executable permissions are unsafe');
  assert(state.realpath === FLATPAK_BINARY, 'FLATPAK_BINARY_UNTRUSTED', 'Flatpak executable must resolve to the approved system path');
  return true;
}

function parseRemoteTrust(stdout, remote) {
  const wanted = validateRemoteId(remote);
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\t+/);
    if (fields.length < 2 || fields[0] !== wanted) continue;
    const gpgVerify = String(fields[1] || '').trim().toLowerCase();
    return { configured: true, gpgVerify: gpgVerify === 'true' || gpgVerify === 'yes' || gpgVerify === '1' };
  }
  return { configured: false, gpgVerify: false };
}

export function validateFlatpakManifest(manifest, { allowlistedRemotes = [] } = {}) {
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'INVALID_MANIFEST', 'Package manifest must be an object');
  assert(manifest.schema === 'swir.package-provider/0.2', 'UNSUPPORTED_SCHEMA', 'Unsupported package provider schema');
  assert(Array.isArray(manifest.targetEditions) && manifest.targetEditions.includes('system'), 'WRONG_EDITION', 'Flatpak package must target System Edition');
  assert(manifest.executionClass === 'linux-native', 'WRONG_EXECUTION_CLASS', 'Flatpak provider accepts linux-native packages only');
  assert(manifest.provider === 'swir.package.flatpak', 'WRONG_PROVIDER', 'Flatpak provider requires swir.package.flatpak');
  assert(manifest.package && typeof manifest.package === 'object' && !Array.isArray(manifest.package), 'INVALID_PACKAGE', 'Flatpak package metadata is required');
  const appId = validateAppId(manifest.package.sourceRef);
  assert(manifest.package.nativeEntryPoint === appId, 'ENTRY_POINT_MISMATCH', 'Flatpak nativeEntryPoint must match the application ID');
  const remote = validateRemoteId(manifest.package.remote || manifest.trust?.repositoryId);
  assert(manifest.trust && typeof manifest.trust === 'object' && !Array.isArray(manifest.trust), 'INVALID_TRUST', 'Flatpak trust metadata is required');
  assert(manifest.trust.sourceClass === 'flatpak-remote', 'WRONG_SOURCE_CLASS', 'Flatpak provider requires flatpak-remote trust');
  assert(manifest.trust.signatureRequired === true, 'SIGNATURE_REQUIRED', 'Flatpak remote signature verification must be required');
  if (manifest.trust.repositoryId != null) assert(manifest.trust.repositoryId === remote, 'REMOTE_TRUST_MISMATCH', 'Flatpak remote and trust repositoryId must match');
  const allowed = new Set(uniqueStrings(allowlistedRemotes));
  assert(allowed.has(remote), 'REMOTE_NOT_ALLOWLISTED', 'Flatpak remote is not allowlisted by the System image policy');
  assert(manifest.package.scope == null || manifest.package.scope === 'user', 'SYSTEM_SCOPE_NOT_SUPPORTED', 'Flatpak provider 0.1 supports user scope only');
  return { appId, remote };
}

function buildArgs(operation, appId, remote) {
  if (operation === 'install') return ['--user', '--noninteractive', 'install', '--or-update', remote, appId];
  if (operation === 'update') return ['--user', '--noninteractive', 'update', appId];
  return ['--user', '--noninteractive', 'uninstall', appId];
}

export function buildFlatpakUserPlan(operation, manifest, { allowlistedRemotes = [] } = {}) {
  validateOperation(operation);
  const { appId, remote } = validateFlatpakManifest(manifest, { allowlistedRemotes });
  return Object.freeze({
    schema: 'swir.flatpak-user-plan/0.1',
    provider: 'swir.package.flatpak',
    executionClass: 'linux-native',
    operation,
    package: Object.freeze({
      id: manifest.id,
      sourceRef: appId,
      remote,
      scope: 'user'
    }),
    trust: Object.freeze({
      sourceClass: 'flatpak-remote',
      repositoryId: remote,
      signatureVerificationRequired: true,
      preconfiguredRemoteRequired: true,
      runtimeRemoteGpgVerificationRequired: true,
      arbitraryRemoteUrlAllowed: false
    }),
    transaction: Object.freeze({
      requiresPrivilege: false,
      shellAllowed: false,
      swirJournalRequired: false,
      nativeAtomicity: 'flatpak-ostree',
      rollback: Object.freeze({ supported: false, mechanism: null, note: 'Version-aware SWIR rollback metadata is not implemented for Flatpak 0.1.' })
    }),
    command: Object.freeze({
      executable: FLATPAK_BINARY,
      args: Object.freeze(buildArgs(operation, appId, remote))
    })
  });
}

function expectedArgs(plan) {
  return buildArgs(plan.operation, plan.package.sourceRef, plan.package.remote);
}

export function validateFlatpakUserPlan(plan, { allowlistedRemotes = [] } = {}) {
  assert(plan && typeof plan === 'object' && !Array.isArray(plan), 'INVALID_PLAN', 'Flatpak plan must be an object');
  assert(plan.schema === 'swir.flatpak-user-plan/0.1', 'INVALID_PLAN_SCHEMA', 'Unsupported Flatpak plan schema');
  assert(plan.provider === 'swir.package.flatpak', 'INVALID_PLAN_PROVIDER', 'Flatpak plan provider mismatch');
  validateOperation(plan.operation);
  const appId = validateAppId(plan.package?.sourceRef);
  const remote = validateRemoteId(plan.package?.remote);
  assert(plan.package?.scope === 'user', 'INVALID_PLAN_SCOPE', 'Flatpak plan must remain user scoped');
  assert(new Set(uniqueStrings(allowlistedRemotes)).has(remote), 'REMOTE_NOT_ALLOWLISTED', 'Flatpak plan remote is not allowlisted');
  assert(plan.trust?.signatureVerificationRequired === true, 'SIGNATURE_REQUIRED', 'Flatpak plan must require signature verification');
  assert(plan.trust?.preconfiguredRemoteRequired === true, 'REMOTE_CONFIGURATION_REQUIRED', 'Flatpak plan must require a preconfigured remote');
  assert(plan.trust?.runtimeRemoteGpgVerificationRequired === true, 'REMOTE_GPG_POLICY_REQUIRED', 'Flatpak plan must require runtime remote GPG verification');
  assert(plan.trust?.arbitraryRemoteUrlAllowed === false, 'REMOTE_URL_POLICY_VIOLATION', 'Flatpak plan cannot allow arbitrary remote URLs');
  assert(plan.transaction?.requiresPrivilege === false, 'PRIVILEGE_POLICY_VIOLATION', 'Flatpak user plan cannot request privilege');
  assert(plan.transaction?.shellAllowed === false, 'SHELL_POLICY_VIOLATION', 'Flatpak user plan cannot enable shell execution');
  assert(plan.command?.executable === FLATPAK_BINARY, 'EXECUTABLE_POLICY_VIOLATION', 'Flatpak executable path is not approved');
  const actualArgs = Array.isArray(plan.command?.args) ? plan.command.args : [];
  const wanted = expectedArgs({ operation: plan.operation, package: { sourceRef: appId, remote } });
  assert(JSON.stringify(actualArgs) === JSON.stringify(wanted), 'ARGUMENT_POLICY_VIOLATION', 'Flatpak command arguments do not match the reviewed operation template');
  return plan;
}

export class GuardedFlatpakUserExecutor {
  #runner;
  #fileProbe;
  #allowlistedRemotes;
  #timeoutMs;

  constructor({ runner = spawnSync, fileProbe = defaultFileProbe, allowlistedRemotes = [], timeoutMs = 120000 } = {}) {
    assert(typeof runner === 'function', 'INVALID_RUNNER', 'Flatpak executor runner must be a function');
    assert(typeof fileProbe === 'function', 'INVALID_FILE_PROBE', 'Flatpak fileProbe must be a function');
    assert(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 900000, 'INVALID_TIMEOUT', 'Flatpak executor timeout is outside the allowed range');
    this.#runner = runner;
    this.#fileProbe = fileProbe;
    this.#allowlistedRemotes = uniqueStrings(allowlistedRemotes);
    this.#timeoutMs = timeoutMs;
  }

  probe(remote) {
    const remoteId = validateRemoteId(remote);
    assert(this.#allowlistedRemotes.includes(remoteId), 'REMOTE_NOT_ALLOWLISTED', 'Flatpak remote is not allowlisted');
    verifyFlatpakBinary(this.#fileProbe);
    const args = ['--user', 'remotes', '--columns=name,gpg-verify'];
    const result = this.#runner(FLATPAK_BINARY, args, runtimeOptions(Math.min(this.#timeoutMs, 20000)));
    if (result?.error) fail('FLATPAK_REMOTE_PROBE_FAILED', `Flatpak remote probe failed: ${result.error.message || 'unknown error'}`);
    assert(Number.isInteger(result?.status) && result.status === 0, 'FLATPAK_REMOTE_PROBE_FAILED', 'Flatpak remote probe did not complete successfully');
    const trust = parseRemoteTrust(result.stdout, remoteId);
    assert(trust.configured, 'FLATPAK_REMOTE_NOT_CONFIGURED', 'Allowlisted Flatpak remote is not configured for the current user');
    assert(trust.gpgVerify, 'FLATPAK_REMOTE_GPG_REQUIRED', 'Configured Flatpak remote does not enforce GPG verification');
    return Object.freeze({ schema: 'swir.flatpak-runtime-trust/0.1', binary: FLATPAK_BINARY, trustedBinary: true, remote: remoteId, configured: true, gpgVerify: true });
  }

  execute(plan) {
    validateFlatpakUserPlan(plan, { allowlistedRemotes: this.#allowlistedRemotes });
    const runtimeTrust = this.probe(plan.package.remote);
    const result = this.#runner(FLATPAK_BINARY, [...plan.command.args], runtimeOptions(this.#timeoutMs));
    if (result?.error) fail('FLATPAK_EXECUTION_ERROR', `Flatpak execution failed: ${result.error.message || 'unknown error'}`);
    assert(Number.isInteger(result?.status), 'FLATPAK_NO_STATUS', 'Flatpak execution did not return an exit status');
    assert(result.status === 0, 'FLATPAK_COMMAND_FAILED', `Flatpak operation failed with exit status ${result.status}`);
    return Object.freeze({
      schema: 'swir.flatpak-user-result/0.1',
      provider: 'swir.package.flatpak',
      operation: plan.operation,
      packageId: plan.package.id,
      sourceRef: plan.package.sourceRef,
      remote: plan.package.remote,
      scope: 'user',
      state: 'committed',
      exitStatus: result.status,
      runtimeTrust
    });
  }
}

export class FlatpakUserPackageAdapter {
  #allowlistedRemotes;
  #executor;

  constructor({ allowlistedRemotes = [], executor } = {}) {
    this.#allowlistedRemotes = uniqueStrings(allowlistedRemotes);
    assert(this.#allowlistedRemotes.length > 0, 'EMPTY_REMOTE_POLICY', 'At least one Flatpak remote must be explicitly allowlisted');
    this.#executor = executor || new GuardedFlatpakUserExecutor({ allowlistedRemotes: this.#allowlistedRemotes });
    assert(this.#executor && typeof this.#executor.execute === 'function', 'INVALID_EXECUTOR', 'Flatpak executor must expose execute()');
  }

  describe() {
    return Object.freeze({
      schema: 'swir.package-provider-adapter/0.1',
      provider: 'swir.package.flatpak',
      kind: 'flatpak',
      available: true,
      scope: 'user',
      privilegedMutation: false,
      allowlistedRemotes: [...this.#allowlistedRemotes],
      remoteTrustVerification: 'preconfigured-gpg-verified-at-execution',
      binaryTrustVerification: 'root-owned-fixed-path-at-execution',
      arbitraryRemoteUrlAllowed: false,
      shellAllowed: false
    });
  }

  plan(operation, manifest) {
    return buildFlatpakUserPlan(operation, clone(manifest), { allowlistedRemotes: this.#allowlistedRemotes });
  }

  async execute(operation, manifest) {
    const plan = this.plan(operation, manifest);
    return this.#executor.execute(plan);
  }

  async recoverPending() {
    return [];
  }
}

export function createFlatpakUserPackageAdapter({ allowlistedRemotes } = {}) {
  return new FlatpakUserPackageAdapter({ allowlistedRemotes });
}

export const FlatpakUserPackagePolicy = Object.freeze({
  schema: 'swir.flatpak-user-plan/0.1',
  provider: 'swir.package.flatpak',
  executionClass: 'linux-native',
  scope: 'user',
  executable: FLATPAK_BINARY,
  arbitraryRemoteUrls: false,
  preconfiguredAllowlistedRemoteRequired: true,
  signatureVerificationRequired: true,
  runtimeRemoteGpgVerificationRequired: true,
  binaryTrustRequired: true,
  shellAllowed: false,
  privilegedMutation: false,
  swirJournalRequired: false,
  nativeAtomicity: 'flatpak-ostree',
  versionAwareRollbackImplemented: false
});