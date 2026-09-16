import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const REQUEST_SCHEMA = 'swir.system-authorization-request/0.1';
const GRANT_SCHEMA = 'swir.system-authorization-grant/0.1';
const PLAN_DIGEST = /^[a-f0-9]{64}$/;
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATIONS = new Set(['install', 'update', 'remove']);
const SCOPE_ACTION = Object.freeze({
  'packages.mutate': 'org.swir.system.packages.mutate',
  'packages.recover': 'org.swir.system.packages.recover'
});
const MAX_OUTPUT_BYTES = 64 * 1024;

function assert(condition, code, message) {
  if (!condition) throw new PolkitAuthorizationError(code, message);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateToken(value, pattern, code, message) {
  assert(typeof value === 'string' && pattern.test(value), code, message);
  return value;
}

function parseProcStartTime(statText) {
  const text = String(statText || '');
  const end = text.lastIndexOf(') ');
  assert(end > 0, 'SUBJECT_PROBE_FAILED', 'could not parse /proc process stat');
  const fields = text.slice(end + 2).trim().split(/\s+/);
  const startTime = fields[19];
  assert(typeof startTime === 'string' && /^[0-9]+$/.test(startTime), 'SUBJECT_PROBE_FAILED', 'process start time is unavailable');
  return startTime;
}

function defaultProcessProbe(pid = process.pid) {
  assert(Number.isInteger(pid) && pid > 0, 'INVALID_PROCESS_SUBJECT', 'process id must be a positive integer');
  assert(typeof process.getuid === 'function', 'UID_UNAVAILABLE', 'System Edition authorization requires a Unix uid');
  const uid = process.getuid();
  assert(Number.isInteger(uid) && uid >= 0, 'UID_UNAVAILABLE', 'System Edition authorization requires a valid Unix uid');
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return { pid, uid, startTime: parseProcStartTime(stat) };
}

function defaultFileProbe(filePath) {
  const stat = fs.lstatSync(filePath);
  return {
    isFile: stat.isFile(),
    isSymbolicLink: stat.isSymbolicLink(),
    uid: stat.uid,
    mode: stat.mode
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

export class PolkitAuthorizationError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PolkitAuthorizationError';
    this.code = code;
  }
}

export function validateSystemAuthorizationRequest(request) {
  assert(isObject(request), 'INVALID_AUTHORIZATION_REQUEST', 'authorization request must be an object');
  assert(request.schema === REQUEST_SCHEMA, 'INVALID_AUTHORIZATION_SCHEMA', `authorization request schema must be ${REQUEST_SCHEMA}`);
  assert(Object.prototype.hasOwnProperty.call(SCOPE_ACTION, request.scope), 'UNSUPPORTED_AUTHORIZATION_SCOPE', 'unsupported System authorization scope');
  validateToken(request.planDigest, PLAN_DIGEST, 'INVALID_PLAN_DIGEST', 'authorization request requires a lowercase SHA-256 plan digest');
  validateToken(request.packageId, PACKAGE_ID, 'INVALID_PACKAGE_ID', 'authorization request requires a safe package id');
  assert(OPERATIONS.has(request.operation), 'INVALID_PACKAGE_OPERATION', 'authorization request operation is unsupported');
  assert(request.context === undefined || isObject(request.context), 'INVALID_AUTHORIZATION_CONTEXT', 'authorization context must be an object');
  return request;
}

function assertTrustedPkcheck(filePath, fileProbe) {
  let stat;
  try {
    stat = fileProbe(filePath);
  } catch (error) {
    throw new PolkitAuthorizationError('POLKIT_BINARY_UNAVAILABLE', `pkcheck is unavailable at ${filePath}`, error);
  }
  assert(stat?.isFile === true && stat?.isSymbolicLink !== true, 'UNTRUSTED_POLKIT_BINARY', 'pkcheck must be a regular non-symlink file');
  assert(stat.uid === 0, 'UNTRUSTED_POLKIT_BINARY_OWNER', 'pkcheck must be owned by root');
  assert(Number.isInteger(stat.mode) && (stat.mode & 0o022) === 0, 'UNTRUSTED_POLKIT_BINARY_MODE', 'pkcheck must not be group/world writable');
}

function normalizedActorId(subject) {
  return `uid:${subject.uid}`;
}

function buildPkcheckArgs(actionId, request, subject, allowUserInteraction) {
  const args = [
    '--action-id', actionId,
    '--process', `${subject.pid},${subject.startTime},${subject.uid}`,
    '--detail', 'swir.scope', request.scope,
    '--detail', 'swir.planDigest', request.planDigest,
    '--detail', 'swir.packageId', request.packageId,
    '--detail', 'swir.operation', request.operation
  ];
  if (allowUserInteraction) args.push('--allow-user-interaction');
  return args;
}

export class PolkitSystemAuthorizationBroker {
  #pkcheckPath;
  #processProbe;
  #fileProbe;
  #runner;
  #clock;
  #grantIdFactory;
  #timeoutMs;

  constructor({
    pkcheckPath = '/usr/bin/pkcheck',
    processProbe = defaultProcessProbe,
    fileProbe = defaultFileProbe,
    runner = defaultRunner,
    clock = () => new Date().toISOString(),
    grantIdFactory = () => crypto.randomUUID(),
    timeoutMs = 30_000
  } = {}) {
    assert(typeof pkcheckPath === 'string' && pkcheckPath.startsWith('/'), 'INVALID_POLKIT_PATH', 'pkcheck path must be absolute');
    assert(typeof processProbe === 'function', 'INVALID_PROCESS_PROBE', 'processProbe must be a function');
    assert(typeof fileProbe === 'function', 'INVALID_FILE_PROBE', 'fileProbe must be a function');
    assert(typeof runner === 'function', 'INVALID_RUNNER', 'runner must be a function');
    assert(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 120_000, 'INVALID_TIMEOUT', 'authorization timeout must be between 1s and 120s');
    this.#pkcheckPath = pkcheckPath;
    this.#processProbe = processProbe;
    this.#fileProbe = fileProbe;
    this.#runner = runner;
    this.#clock = clock;
    this.#grantIdFactory = grantIdFactory;
    this.#timeoutMs = timeoutMs;
  }

  async authorize(input) {
    const request = validateSystemAuthorizationRequest(input);
    assertTrustedPkcheck(this.#pkcheckPath, this.#fileProbe);

    const subject = await this.#processProbe(process.pid);
    assert(isObject(subject), 'SUBJECT_PROBE_FAILED', 'process probe must return an object');
    assert(Number.isInteger(subject.pid) && subject.pid > 0, 'SUBJECT_PROBE_FAILED', 'process probe returned invalid pid');
    assert(Number.isInteger(subject.uid) && subject.uid >= 0, 'SUBJECT_PROBE_FAILED', 'process probe returned invalid uid');
    assert(typeof subject.startTime === 'string' && /^[0-9]+$/.test(subject.startTime), 'SUBJECT_PROBE_FAILED', 'process probe returned invalid start time');

    const actorId = normalizedActorId(subject);
    if (request.context?.actorId !== undefined) {
      assert(request.context.actorId === actorId, 'ACTOR_BINDING_MISMATCH', 'requested actor does not match the current Unix process subject');
    }

    const allowUserInteraction = request.context?.allowUserInteraction === true;
    const actionId = SCOPE_ACTION[request.scope];
    const args = buildPkcheckArgs(actionId, request, subject, allowUserInteraction);
    const result = await this.#runner(this.#pkcheckPath, args, {
      timeoutMs: this.#timeoutMs,
      env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' })
    });

    assert(isObject(result), 'POLKIT_EXECUTION_FAILED', 'pkcheck runner returned invalid result');
    if (result.signal) throw new PolkitAuthorizationError('POLKIT_EXECUTION_INTERRUPTED', `pkcheck terminated by ${result.signal}`);
    if (result.exitCode !== 0) {
      return {
        schema: GRANT_SCHEMA,
        authorized: false,
        scope: request.scope,
        actionId,
        actorId,
        packageId: request.packageId,
        operation: request.operation,
        planDigest: request.planDigest,
        reason: result.exitCode === 1 ? 'not-authorized' : 'authorization-check-failed'
      };
    }

    const grantId = this.#grantIdFactory();
    assert(typeof grantId === 'string' && /^[A-Za-z0-9._:-]{8,160}$/.test(grantId), 'INVALID_GRANT_ID', 'grantIdFactory returned an unsafe grant id');
    return {
      schema: GRANT_SCHEMA,
      authorized: true,
      grantId,
      actorId,
      scope: request.scope,
      actionId,
      packageId: request.packageId,
      operation: request.operation,
      planDigest: request.planDigest,
      subject: { pid: subject.pid, uid: subject.uid, startTime: subject.startTime },
      interactive: allowUserInteraction,
      authorizedAt: this.#clock()
    };
  }
}

export const SystemPolkitAuthorizationPolicy = Object.freeze({
  schema: GRANT_SCHEMA,
  scopes: { ...SCOPE_ACTION },
  subject: 'current-process-with-pid-start-time-uid-binding',
  arbitrarySubjectOverride: false,
  shellExecution: false,
  inheritedEnvironment: false,
  userInteractionDefault: false,
  planDigestBinding: true,
  packageIdentityBinding: true,
  operationBinding: true
});
