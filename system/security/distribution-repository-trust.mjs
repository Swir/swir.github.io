import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const POLICY_SCHEMA = 'swir.system-repository-trust-policy/0.1';
const PROOF_SCHEMA = 'swir.repository-trust-proof/0.1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,191}$/;
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9+._:@-]{0,127}$/;
const MANAGERS = new Set(['apt', 'dnf', 'rpm-ostree', 'pacman', 'zypper']);
const MAX_OUTPUT_BYTES = 256 * 1024;

function assert(condition, code, message) {
  if (!condition) throw new RepositoryTrustError(code, message);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function defaultFileProbe(filePath) {
  const stat = fs.lstatSync(filePath);
  return {
    isFile: stat.isFile(),
    isSymbolicLink: stat.isSymbolicLink(),
    uid: stat.uid,
    mode: stat.mode,
    size: stat.size
  };
}

function defaultRunner(command, args, options) {
  const result = spawnSync(command, args, {
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: options.env
  });
  if (result.error) throw result.error;
  return {
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal || null,
    stdout: String(result.stdout || '').slice(0, MAX_OUTPUT_BYTES),
    stderr: String(result.stderr || '').slice(0, MAX_OUTPUT_BYTES)
  };
}

function safeToken(value, pattern, code, message) {
  assert(typeof value === 'string' && pattern.test(value), code, message);
  return value;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function policyDigest(policy) {
  return crypto.createHash('sha256').update(stableStringify(policy), 'utf8').digest('hex');
}

function validateRepositoryEntry(entry) {
  assert(isObject(entry), 'INVALID_REPOSITORY_POLICY', 'repository policy entry must be an object');
  safeToken(entry.id, SAFE_ID, 'INVALID_REPOSITORY_ID', 'repository policy id is invalid');
  assert(MANAGERS.has(entry.manager), 'INVALID_REPOSITORY_MANAGER', 'repository policy manager is unsupported');
  safeToken(entry.nativeId, SAFE_ID, 'INVALID_NATIVE_REPOSITORY_ID', 'native repository id is invalid');
  assert(entry.sourceClass === 'distribution-repository', 'INVALID_SOURCE_CLASS', 'repository policy source class must be distribution-repository');
  assert(entry.enabled === true, 'REPOSITORY_DISABLED', 'repository policy entry must be explicitly enabled');
  assert(entry.signatureVerification === 'native-required', 'SIGNATURE_POLICY_REQUIRED', 'repository policy must require native package-manager signature verification');
  assert(entry.allowInsecure === false, 'INSECURE_REPOSITORY_POLICY', 'repository policy must explicitly disallow insecure repository mode');
  assert(Array.isArray(entry.distributions) && entry.distributions.length > 0, 'INVALID_DISTRIBUTION_POLICY', 'repository policy must list supported distributions');
  for (const distribution of entry.distributions) safeToken(distribution, SAFE_ID, 'INVALID_DISTRIBUTION_POLICY', 'repository distribution id is invalid');
  return entry;
}

export class RepositoryTrustError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RepositoryTrustError';
    this.code = code;
  }
}

export function validateRepositoryTrustPolicy(policy) {
  assert(isObject(policy), 'INVALID_REPOSITORY_POLICY', 'repository trust policy must be an object');
  assert(policy.schema === POLICY_SCHEMA, 'INVALID_REPOSITORY_POLICY_SCHEMA', `repository trust policy schema must be ${POLICY_SCHEMA}`);
  assert(policy.defaultRepositoryId === null || typeof policy.defaultRepositoryId === 'string', 'INVALID_DEFAULT_REPOSITORY', 'defaultRepositoryId must be string or null');
  assert(Array.isArray(policy.repositories) && policy.repositories.length > 0, 'EMPTY_REPOSITORY_POLICY', 'repository trust policy must contain at least one repository');
  const seen = new Set();
  for (const entry of policy.repositories) {
    validateRepositoryEntry(entry);
    assert(!seen.has(entry.id), 'DUPLICATE_REPOSITORY_ID', `duplicate repository policy id: ${entry.id}`);
    seen.add(entry.id);
  }
  if (policy.defaultRepositoryId !== null) assert(seen.has(policy.defaultRepositoryId), 'UNKNOWN_DEFAULT_REPOSITORY', 'defaultRepositoryId must reference a configured repository');
  return policy;
}

function assertTrustedPolicyFile(filePath, fileProbe) {
  let stat;
  try {
    stat = fileProbe(filePath);
  } catch (error) {
    throw new RepositoryTrustError('REPOSITORY_POLICY_UNAVAILABLE', `repository trust policy is unavailable at ${filePath}`, error);
  }
  assert(stat?.isFile === true && stat?.isSymbolicLink !== true, 'UNSAFE_REPOSITORY_POLICY_FILE', 'repository trust policy must be a regular non-symlink file');
  assert(stat.uid === 0, 'UNSAFE_REPOSITORY_POLICY_OWNER', 'repository trust policy must be owned by root');
  assert(Number.isInteger(stat.mode) && (stat.mode & 0o022) === 0, 'UNSAFE_REPOSITORY_POLICY_MODE', 'repository trust policy must not be group/world writable');
  assert(!Number.isInteger(stat.size) || stat.size <= 1024 * 1024, 'REPOSITORY_POLICY_TOO_LARGE', 'repository trust policy exceeds size limit');
}

export function loadRepositoryTrustPolicy(filePath, { fileProbe = defaultFileProbe, readFile = p => fs.readFileSync(p, 'utf8') } = {}) {
  assert(typeof filePath === 'string' && filePath.startsWith('/'), 'INVALID_REPOSITORY_POLICY_PATH', 'repository trust policy path must be absolute');
  assertTrustedPolicyFile(filePath, fileProbe);
  let parsed;
  try {
    parsed = JSON.parse(readFile(filePath));
  } catch (error) {
    throw new RepositoryTrustError('INVALID_REPOSITORY_POLICY_JSON', 'repository trust policy is not valid JSON', error);
  }
  return validateRepositoryTrustPolicy(parsed);
}

const MANAGER_PROBES = Object.freeze({
  apt: {
    command: '/usr/bin/apt-cache',
    args: ({ packageName }) => ['policy', packageName],
    verify: ({ stdout, nativeId }) => /Candidate:\s*(?!\(none\))/i.test(stdout) && stdout.includes(nativeId)
  },
  dnf: {
    command: '/usr/bin/dnf',
    args: ({ packageName, nativeId }) => ['--quiet', '--disablerepo=*', `--enablerepo=${nativeId}`, 'repoquery', '--latest-limit=1', '--qf', '%{name}', '--', packageName],
    verify: ({ stdout, packageName }) => stdout.split(/\r?\n/).some(line => line.trim() === packageName)
  },
  'rpm-ostree': {
    command: '/usr/bin/rpm-ostree',
    args: () => ['status', '--json'],
    verify: ({ stdout }) => {
      try {
        const parsed = JSON.parse(stdout);
        return Array.isArray(parsed?.deployments) && parsed.deployments.length > 0;
      } catch { return false; }
    }
  },
  pacman: {
    command: '/usr/bin/pacman',
    args: ({ packageName, nativeId }) => ['-Sl', nativeId, packageName],
    verify: ({ stdout, packageName, nativeId }) => stdout.split(/\r?\n/).some(line => line.trim().startsWith(`${nativeId} ${packageName} `))
  },
  zypper: {
    command: '/usr/bin/zypper',
    args: ({ packageName, nativeId }) => ['--non-interactive', '--xmlout', 'search', '--match-exact', '--repo', nativeId, '--', packageName],
    verify: ({ stdout, packageName }) => stdout.includes(`name=\"${packageName}\"`) || stdout.includes(`name='${packageName}'`)
  }
});

function assertTrustedManagerBinary(command, fileProbe) {
  let stat;
  try {
    stat = fileProbe(command);
  } catch (error) {
    throw new RepositoryTrustError('PACKAGE_MANAGER_BINARY_UNAVAILABLE', `required read-only package manager probe is unavailable at ${command}`, error);
  }
  assert(stat?.isFile === true && stat?.isSymbolicLink !== true, 'UNTRUSTED_PACKAGE_MANAGER_BINARY', 'package manager probe must be a regular non-symlink file');
  assert(stat.uid === 0, 'UNTRUSTED_PACKAGE_MANAGER_OWNER', 'package manager probe must be root-owned');
  assert(Number.isInteger(stat.mode) && (stat.mode & 0o022) === 0, 'UNTRUSTED_PACKAGE_MANAGER_MODE', 'package manager probe must not be group/world writable');
}

export class DistributionRepositoryTrustVerifier {
  #policy;
  #policySha256;
  #fileProbe;
  #runner;
  #timeoutMs;
  #clock;
  #proofIdFactory;

  constructor({ policy, fileProbe = defaultFileProbe, runner = defaultRunner, timeoutMs = 20_000, clock = () => new Date().toISOString(), proofIdFactory = () => crypto.randomUUID() } = {}) {
    this.#policy = validateRepositoryTrustPolicy(policy);
    this.#policySha256 = policyDigest(this.#policy);
    this.#fileProbe = fileProbe;
    this.#runner = runner;
    this.#timeoutMs = timeoutMs;
    this.#clock = clock;
    this.#proofIdFactory = proofIdFactory;
  }

  async verifyRepository({ repositoryId, manager, distribution, packageName, operation, signatureRequired }) {
    assert(MANAGERS.has(manager), 'UNSUPPORTED_PACKAGE_MANAGER', 'repository trust verifier received unsupported package manager');
    safeToken(packageName, PACKAGE_NAME, 'INVALID_PACKAGE_NAME', 'repository trust verifier received invalid package name');
    assert(['install', 'update', 'remove'].includes(operation), 'INVALID_PACKAGE_OPERATION', 'repository trust verifier received invalid operation');
    assert(signatureRequired === true, 'SIGNATURE_POLICY_REQUIRED', 'repository signature verification must remain required');

    const resolvedRepositoryId = repositoryId || this.#policy.defaultRepositoryId;
    assert(typeof resolvedRepositoryId === 'string' && resolvedRepositoryId.length > 0, 'REPOSITORY_ID_REQUIRED', 'no repository id or trusted default repository is configured');
    const entry = this.#policy.repositories.find(item => item.id === resolvedRepositoryId);
    assert(Boolean(entry), 'REPOSITORY_NOT_IN_TRUST_POLICY', 'repository is not present in the trusted System policy');
    assert(entry.manager === manager, 'REPOSITORY_MANAGER_MISMATCH', 'repository policy manager does not match selected package manager');
    const distributionId = String(distribution?.id || '').trim();
    assert(distributionId && entry.distributions.includes(distributionId), 'REPOSITORY_DISTRIBUTION_MISMATCH', 'repository policy does not permit this distribution');

    if (operation === 'remove') {
      return this.#proof(entry, manager, distributionId, packageName, operation, 'policy-only-remove');
    }

    const probe = MANAGER_PROBES[manager];
    assertTrustedManagerBinary(probe.command, this.#fileProbe);
    const args = probe.args({ packageName, nativeId: entry.nativeId });
    assert(args.every(arg => typeof arg === 'string' && arg.length > 0 && !/[\0\r\n]/.test(arg)), 'INVALID_PROBE_ARGUMENT', 'repository probe generated an unsafe argument');
    const result = await this.#runner(probe.command, args, {
      timeoutMs: this.#timeoutMs,
      env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' })
    });
    assert(isObject(result), 'REPOSITORY_PROBE_FAILED', 'repository probe returned invalid result');
    assert(result.signal === null || result.signal === undefined, 'REPOSITORY_PROBE_INTERRUPTED', `repository probe terminated by ${result.signal}`);
    assert(result.exitCode === 0, 'REPOSITORY_PROBE_FAILED', 'native package-manager repository probe failed');
    assert(probe.verify({ stdout: String(result.stdout || ''), stderr: String(result.stderr || ''), nativeId: entry.nativeId, packageName }), 'PACKAGE_NOT_PROVEN_IN_TRUSTED_REPOSITORY', 'package manager could not prove the package is available from the configured trusted repository');

    return this.#proof(entry, manager, distributionId, packageName, operation, 'native-read-only-probe');
  }

  #proof(entry, manager, distributionId, packageName, operation, evidence) {
    const proofId = this.#proofIdFactory();
    assert(typeof proofId === 'string' && /^[A-Za-z0-9._:-]{8,160}$/.test(proofId), 'INVALID_PROOF_ID', 'proofIdFactory returned an unsafe proof id');
    return {
      schema: PROOF_SCHEMA,
      verified: true,
      proofId,
      repositoryId: entry.id,
      nativeRepositoryId: entry.nativeId,
      manager,
      distributionId,
      packageName,
      operation,
      signatureVerification: 'native-required',
      allowInsecure: false,
      evidence,
      policySha256: this.#policySha256,
      verifiedAt: this.#clock()
    };
  }
}

export const SystemRepositoryTrustPolicy = Object.freeze({
  schema: POLICY_SCHEMA,
  proofSchema: PROOF_SCHEMA,
  sourceClass: 'distribution-repository',
  signatureVerification: 'native-required',
  allowInsecure: false,
  arbitraryRepositoryUrls: false,
  rootOwnedPolicyRequired: true,
  readOnlyNativeProbeRequiredForInstallUpdate: true,
  shellExecution: false,
  inheritedEnvironment: false
});
