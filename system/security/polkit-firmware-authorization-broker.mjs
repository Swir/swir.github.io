import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const REQUEST_SCHEMA = 'swir.firmware-authorization-request/0.1';
const GRANT_SCHEMA = 'swir.firmware-authorization-grant/0.1';
const PLAN_DIGEST = /^[a-f0-9]{64}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTIONS = Object.freeze({
  update: 'org.swir.system.firmware.update',
  recover: 'org.swir.system.firmware.recover'
});
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_PKCHECK = '/usr/bin/pkcheck';

function assert(condition, code, message) {
  if (!condition) throw new PolkitFirmwareAuthorizationError(code, message);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
  assert(Number.isInteger(pid) && pid > 0, 'INVALID_PROCESS_SUBJECT', 'process id must be positive');
  assert(typeof process.getuid === 'function', 'UID_UNAVAILABLE', 'System Edition authorization requires a Unix uid');
  const uid = process.getuid();
  assert(Number.isInteger(uid) && uid >= 0, 'UID_UNAVAILABLE', 'System Edition authorization requires a valid Unix uid');
  return { pid, uid, startTime: parseProcStartTime(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) };
}

function defaultFileProbe(filePath) {
  const stat = fs.lstatSync(filePath);
  return { isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink(), uid: stat.uid, mode: stat.mode };
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

export class PolkitFirmwareAuthorizationError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PolkitFirmwareAuthorizationError';
    this.code = code;
  }
}

export function validateFirmwareAuthorizationRequest(request) {
  assert(isObject(request), 'INVALID_AUTHORIZATION_REQUEST', 'authorization request must be an object');
  assert(request.schema === REQUEST_SCHEMA, 'INVALID_AUTHORIZATION_SCHEMA', `authorization request schema must be ${REQUEST_SCHEMA}`);
  assert(Object.prototype.hasOwnProperty.call(ACTIONS, request.operation), 'INVALID_FIRMWARE_OPERATION', 'firmware operation must be update or recover');
  assert(typeof request.planDigest === 'string' && PLAN_DIGEST.test(request.planDigest), 'INVALID_PLAN_DIGEST', 'authorization requires a lowercase SHA-256 plan digest');
  assert(typeof request.deviceId === 'string' && DEVICE_ID.test(request.deviceId), 'INVALID_DEVICE_ID', 'authorization requires a safe fwupd device id');
  assert(request.releaseId === null || request.releaseId === undefined || (typeof request.releaseId === 'string' && RELEASE_ID.test(request.releaseId)), 'INVALID_RELEASE_ID', 'release id contains unsupported characters');
  assert(request.context === undefined || isObject(request.context), 'INVALID_AUTHORIZATION_CONTEXT', 'authorization context must be an object');
  return request;
}

function assertTrustedPkcheck(filePath, fileProbe) {
  let stat;
  try { stat = fileProbe(filePath); } catch (error) {
    throw new PolkitFirmwareAuthorizationError('POLKIT_BINARY_UNAVAILABLE', `pkcheck is unavailable at ${filePath}`, error);
  }
  assert(stat?.isFile === true && stat?.isSymbolicLink !== true, 'UNTRUSTED_POLKIT_BINARY', 'pkcheck must be a regular non-symlink file');
  assert(stat.uid === 0, 'UNTRUSTED_POLKIT_BINARY_OWNER', 'pkcheck must be owned by root');
  assert(Number.isInteger(stat.mode) && (stat.mode & 0o022) === 0, 'UNTRUSTED_POLKIT_BINARY_MODE', 'pkcheck must not be group/world writable');
}

export class PolkitFirmwareAuthorizationBroker {
  #pkcheckPath;
  #processProbe;
  #fileProbe;
  #runner;
  #clock;
  #grantIdFactory;
  #timeoutMs;

  constructor({
    pkcheckPath = DEFAULT_PKCHECK,
    processProbe = defaultProcessProbe,
    fileProbe = defaultFileProbe,
    runner = defaultRunner,
    clock = () => new Date().toISOString(),
    grantIdFactory = () => crypto.randomUUID(),
    timeoutMs = 30_000
  } = {}) {
    assert(pkcheckPath === DEFAULT_PKCHECK, 'INVALID_POLKIT_PATH', 'System Edition authorization is pinned to /usr/bin/pkcheck');
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
    const request = validateFirmwareAuthorizationRequest(input);
    assertTrustedPkcheck(this.#pkcheckPath, this.#fileProbe);
    const subject = await this.#processProbe(process.pid);
    assert(isObject(subject) && Number.isInteger(subject.pid) && subject.pid > 0, 'SUBJECT_PROBE_FAILED', 'process probe returned invalid pid');
    assert(Number.isInteger(subject.uid) && subject.uid >= 0, 'SUBJECT_PROBE_FAILED', 'process probe returned invalid uid');
    assert(typeof subject.startTime === 'string' && /^[0-9]+$/.test(subject.startTime), 'SUBJECT_PROBE_FAILED', 'process probe returned invalid start time');
    const actorId = `uid:${subject.uid}`;
    if (request.context?.actorId !== undefined) {
      assert(request.context.actorId === actorId, 'ACTOR_BINDING_MISMATCH', 'requested actor does not match the current Unix process subject');
    }

    const actionId = ACTIONS[request.operation];
    const args = [
      '--action-id', actionId,
      '--process', `${subject.pid},${subject.startTime},${subject.uid}`,
      '--detail', 'swir.planDigest', request.planDigest,
      '--detail', 'swir.deviceId', request.deviceId,
      '--detail', 'swir.operation', request.operation
    ];
    if (request.releaseId) args.push('--detail', 'swir.releaseId', request.releaseId);
    if (request.context?.allowUserInteraction === true) args.push('--allow-user-interaction');

    const result = await this.#runner(this.#pkcheckPath, args, {
      timeoutMs: this.#timeoutMs,
      env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' })
    });
    assert(isObject(result), 'POLKIT_EXECUTION_FAILED', 'pkcheck runner returned invalid result');
    if (result.signal) throw new PolkitFirmwareAuthorizationError('POLKIT_EXECUTION_INTERRUPTED', `pkcheck terminated by ${result.signal}`);
    if (result.exitCode !== 0) {
      return Object.freeze({
        schema: GRANT_SCHEMA,
        authorized: false,
        actionId,
        operation: request.operation,
        actorId,
        deviceId: request.deviceId,
        releaseId: request.releaseId ?? null,
        planDigest: request.planDigest,
        reason: result.exitCode === 1 ? 'not-authorized' : 'authorization-check-failed'
      });
    }

    const grantId = this.#grantIdFactory();
    assert(typeof grantId === 'string' && /^[A-Za-z0-9._:-]{8,160}$/.test(grantId), 'INVALID_GRANT_ID', 'grantIdFactory returned an unsafe grant id');
    return Object.freeze({
      schema: GRANT_SCHEMA,
      authorized: true,
      grantId,
      actionId,
      operation: request.operation,
      actorId,
      deviceId: request.deviceId,
      releaseId: request.releaseId ?? null,
      planDigest: request.planDigest,
      subject: Object.freeze({ pid: subject.pid, uid: subject.uid, startTime: subject.startTime }),
      interactive: request.context?.allowUserInteraction === true,
      authorizedAt: this.#clock()
    });
  }
}

export const SystemFirmwarePolkitPolicy = Object.freeze({
  schema: GRANT_SCHEMA,
  actions: { ...ACTIONS },
  subject: 'current-process-with-pid-start-time-uid-binding',
  arbitrarySubjectOverride: false,
  arbitraryFwupdArguments: false,
  shellExecution: false,
  inheritedEnvironment: false,
  planDigestBinding: true,
  deviceIdentityBinding: true,
  releaseIdentityBinding: true,
  operationBinding: true
});
