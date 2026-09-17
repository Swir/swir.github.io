import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

const REQUEST_SCHEMA = 'swir.peer-authorization-request/0.1';
const RESPONSE_SCHEMA = 'swir.peer-authorization-response/0.1';
const PAYLOAD_SCHEMA = 'swir.peer-authorization-grant/0.1';
const ENVELOPE_SCHEMA = 'swir.peer-authorization-envelope/0.1';
const ISSUER = 'swir-peer-authorization-broker';
const AUDIENCE = 'swir-system-privileged-services';
const DEFAULT_SOCKET = '/run/swir/peer-authorization.sock';
const DEFAULT_KEY = '/run/swir/peer-authorization.key';
const MAX_WIRE_BYTES = 16 * 1024;
const PLAN_DIGEST = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IFNAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const GRANT_ID = /^[A-Za-z0-9_-]{20,200}$/;
const USERNAME = /^[A-Za-z0-9_.@-]{1,128}$/;
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PACKAGE_OPERATIONS = new Set(['install', 'update', 'remove']);
const NETWORK_OPERATIONS = new Set(['activate', 'deactivate']);
const FIRMWARE_OPERATIONS = new Set(['update', 'recover']);
const SCOPE_ACTION = Object.freeze({
  'packages.mutate': 'org.swir.system.packages.mutate',
  'packages.recover': 'org.swir.system.packages.recover',
  'network.activate': 'org.swir.system.network.activate',
  'network.deactivate': 'org.swir.system.network.deactivate',
  'firmware.update': 'org.swir.system.firmware.update',
  'firmware.recover': 'org.swir.system.firmware.recover'
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'PeerAuthorizationError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function cleanExpectedRequest(request) {
  assert(isObject(request), 'INVALID_PEER_AUTH_REQUEST', 'peer authorization request must be an object');
  assert(request.schema === REQUEST_SCHEMA, 'INVALID_PEER_AUTH_SCHEMA', `request schema must be ${REQUEST_SCHEMA}`);
  assert(Object.prototype.hasOwnProperty.call(SCOPE_ACTION, request.scope), 'UNSUPPORTED_PEER_AUTH_SCOPE', 'unsupported peer authorization scope');
  assert(typeof request.planDigest === 'string' && PLAN_DIGEST.test(request.planDigest), 'INVALID_PLAN_DIGEST', 'planDigest must be lowercase SHA-256');
  assert(request.allowUserInteraction === undefined || typeof request.allowUserInteraction === 'boolean', 'INVALID_INTERACTION_FLAG', 'allowUserInteraction must be boolean');

  const output = {
    schema: REQUEST_SCHEMA,
    scope: request.scope,
    planDigest: request.planDigest,
    allowUserInteraction: request.allowUserInteraction === true
  };
  if (request.scope.startsWith('packages.')) {
    assert(typeof request.packageId === 'string' && SAFE_ID.test(request.packageId), 'INVALID_PACKAGE_ID', 'invalid packageId');
    assert(PACKAGE_OPERATIONS.has(request.operation), 'INVALID_PACKAGE_OPERATION', 'invalid package operation');
    return Object.freeze({ ...output, domain: 'packages', packageId: request.packageId, operation: request.operation });
  }
  if (request.scope.startsWith('network.')) {
    const operation = request.scope.split('.')[1];
    assert(NETWORK_OPERATIONS.has(operation), 'INVALID_NETWORK_OPERATION', 'invalid network scope operation');
    assert(request.operation === undefined || request.operation === operation, 'NETWORK_OPERATION_SCOPE_MISMATCH', 'network operation does not match scope');
    assert(typeof request.connectionUuid === 'string' && UUID.test(request.connectionUuid), 'INVALID_CONNECTION_UUID', 'invalid connection UUID');
    assert(request.ifname === undefined || request.ifname === null || (typeof request.ifname === 'string' && IFNAME.test(request.ifname)), 'INVALID_INTERFACE_NAME', 'invalid interface name');
    return Object.freeze({ ...output, domain: 'network', connectionUuid: request.connectionUuid, ifname: request.ifname ?? null, operation });
  }
  const operation = request.scope.split('.')[1];
  assert(FIRMWARE_OPERATIONS.has(operation), 'INVALID_FIRMWARE_OPERATION', 'invalid firmware scope operation');
  assert(request.operation === undefined || request.operation === operation, 'FIRMWARE_OPERATION_SCOPE_MISMATCH', 'firmware operation does not match scope');
  assert(typeof request.deviceId === 'string' && SAFE_ID.test(request.deviceId), 'INVALID_DEVICE_ID', 'invalid deviceId');
  assert(request.releaseId === undefined || request.releaseId === null || (typeof request.releaseId === 'string' && SAFE_ID.test(request.releaseId)), 'INVALID_RELEASE_ID', 'invalid releaseId');
  return Object.freeze({ ...output, domain: 'firmware', deviceId: request.deviceId, releaseId: request.releaseId ?? null, operation });
}

function validateKeyFile(keyPath, { expectedOwnerUid = 0, allowTestOwner = false } = {}) {
  assert(typeof keyPath === 'string' && keyPath.startsWith('/'), 'AUTH_KEY_PATH_INVALID', 'authorization key path must be absolute');
  let stat;
  try { stat = fs.lstatSync(keyPath); }
  catch (error) { fail('AUTH_KEY_UNAVAILABLE', `authorization key unavailable at ${keyPath}`, error); }
  assert(stat.isFile() && !stat.isSymbolicLink(), 'AUTH_KEY_UNTRUSTED', 'authorization key must be a regular non-symlink file');
  const expected = allowTestOwner ? (typeof process.getuid === 'function' ? process.getuid() : expectedOwnerUid) : expectedOwnerUid;
  if (Number.isInteger(expected) && typeof stat.uid === 'number') assert(stat.uid === expected, 'AUTH_KEY_OWNER_INVALID', 'authorization key owner is invalid');
  assert((stat.mode & 0o777) === 0o600, 'AUTH_KEY_MODE_INVALID', 'authorization key mode must be exactly 0600');
  const key = fs.readFileSync(keyPath);
  assert(key.length === 32, 'AUTH_KEY_LENGTH_INVALID', 'authorization key must contain exactly 32 bytes');
  return key;
}

function validateSubjectAndSession(payload) {
  const subject = payload.subject;
  assert(isObject(subject), 'PEER_SUBJECT_INVALID', 'grant subject is missing');
  assert(Number.isInteger(subject.pid) && subject.pid > 0, 'PEER_SUBJECT_INVALID', 'grant subject pid is invalid');
  assert(Number.isInteger(subject.uid) && subject.uid > 0 && subject.uid <= 0x7fffffff, 'PEER_SUBJECT_INVALID', 'grant subject uid is invalid');
  assert(Number.isInteger(subject.gid) && subject.gid >= 0 && subject.gid <= 0x7fffffff, 'PEER_SUBJECT_INVALID', 'grant subject gid is invalid');
  assert(typeof subject.startTime === 'string' && /^[0-9]+$/.test(subject.startTime), 'PEER_SUBJECT_INVALID', 'grant subject start time is invalid');
  assert(payload.actorId === `uid:${subject.uid}`, 'PEER_ACTOR_MISMATCH', 'grant actorId does not match subject uid');

  const session = payload.session;
  assert(isObject(session), 'PEER_SESSION_INVALID', 'grant session is missing');
  assert(typeof session.id === 'string' && SESSION_ID.test(session.id), 'PEER_SESSION_INVALID', 'grant session id is invalid');
  assert(session.uid === subject.uid, 'PEER_SESSION_UID_MISMATCH', 'grant session uid does not match subject uid');
  assert(typeof session.username === 'string' && USERNAME.test(session.username), 'PEER_SESSION_INVALID', 'grant username is invalid');
  assert(session.seat === null || (typeof session.seat === 'string' && SESSION_ID.test(session.seat)), 'PEER_SESSION_INVALID', 'grant seat is invalid');
  assert(session.type === 'wayland' || session.type === 'x11', 'PEER_SESSION_INVALID', 'grant session must be graphical');
  assert(session.local === true && session.active === true, 'PEER_SESSION_INVALID', 'grant session must be active and local');
  return { subject, session };
}

function assertPayloadMatchesRequest(payload, request) {
  assert(payload.scope === request.scope, 'GRANT_SCOPE_MISMATCH', 'grant scope does not match request');
  assert(payload.actionId === SCOPE_ACTION[request.scope], 'GRANT_ACTION_MISMATCH', 'grant action does not match scope');
  assert(payload.planDigest === request.planDigest, 'GRANT_PLAN_MISMATCH', 'grant plan digest does not match request');
  assert(payload.operation === request.operation, 'GRANT_OPERATION_MISMATCH', 'grant operation does not match request');
  assert(payload.interactive === request.allowUserInteraction, 'GRANT_INTERACTION_MISMATCH', 'grant interaction mode does not match request');
  if (request.domain === 'packages') assert(payload.packageId === request.packageId, 'GRANT_RESOURCE_MISMATCH', 'grant package id does not match request');
  if (request.domain === 'network') {
    assert(payload.connectionUuid === request.connectionUuid, 'GRANT_RESOURCE_MISMATCH', 'grant connection UUID does not match request');
    assert((payload.ifname ?? null) === request.ifname, 'GRANT_RESOURCE_MISMATCH', 'grant interface does not match request');
  }
  if (request.domain === 'firmware') {
    assert(payload.deviceId === request.deviceId, 'GRANT_RESOURCE_MISMATCH', 'grant device id does not match request');
    assert((payload.releaseId ?? null) === request.releaseId, 'GRANT_RESOURCE_MISMATCH', 'grant release id does not match request');
  }
}

export class PeerAuthorizationGrantVerifier {
  #keyPath;
  #clock;
  #maxTtlMs;
  #clockSkewMs;
  #expectedOwnerUid;
  #allowTestOwner;
  #used = new Map();

  constructor({ keyPath = DEFAULT_KEY, clock = () => Date.now(), maxTtlMs = 30_000, clockSkewMs = 2_000, expectedOwnerUid = 0, allowTestOwner = false } = {}) {
    assert(typeof clock === 'function', 'INVALID_CLOCK', 'clock must be a function');
    assert(Number.isInteger(maxTtlMs) && maxTtlMs >= 2_000 && maxTtlMs <= 60_000, 'INVALID_GRANT_TTL', 'maxTtlMs must be between 2s and 60s');
    assert(Number.isInteger(clockSkewMs) && clockSkewMs >= 0 && clockSkewMs <= 10_000, 'INVALID_CLOCK_SKEW', 'clockSkewMs must be between 0 and 10s');
    this.#keyPath = keyPath; this.#clock = clock; this.#maxTtlMs = maxTtlMs; this.#clockSkewMs = clockSkewMs; this.#expectedOwnerUid = expectedOwnerUid; this.#allowTestOwner = allowTestOwner;
  }

  verify(envelope, expectedRequest) {
    const request = cleanExpectedRequest(expectedRequest);
    assert(isObject(envelope) && envelope.schema === ENVELOPE_SCHEMA, 'INVALID_GRANT_ENVELOPE', 'peer grant envelope schema is invalid');
    assert(isObject(envelope.payload), 'INVALID_GRANT_PAYLOAD', 'peer grant payload is missing');
    assert(typeof envelope.mac === 'string' && /^[a-f0-9]{64}$/.test(envelope.mac), 'INVALID_GRANT_MAC', 'peer grant MAC is invalid');
    const key = validateKeyFile(this.#keyPath, { expectedOwnerUid: this.#expectedOwnerUid, allowTestOwner: this.#allowTestOwner });
    const expectedMac = crypto.createHmac('sha256', key).update(stableStringify(envelope.payload), 'utf8').digest('hex');
    const actual = Buffer.from(envelope.mac, 'hex'); const expected = Buffer.from(expectedMac, 'hex');
    assert(actual.length === expected.length && crypto.timingSafeEqual(actual, expected), 'GRANT_MAC_MISMATCH', 'peer authorization grant MAC verification failed');
    const payload = envelope.payload;
    assert(payload.schema === PAYLOAD_SCHEMA, 'INVALID_GRANT_PAYLOAD', 'peer grant payload schema is invalid');
    assert(payload.issuer === ISSUER && payload.audience === AUDIENCE, 'INVALID_GRANT_ISSUER', 'peer grant issuer/audience is invalid');
    assert(payload.authorized === true, 'GRANT_NOT_AUTHORIZED', 'peer grant is not authorized');
    assert(typeof payload.grantId === 'string' && GRANT_ID.test(payload.grantId), 'INVALID_GRANT_ID', 'peer grant id is invalid');
    assert(Number.isInteger(payload.issuedAtMs) && Number.isInteger(payload.expiresAtMs), 'INVALID_GRANT_TIME', 'peer grant timestamps are invalid');
    assert(payload.expiresAtMs > payload.issuedAtMs && payload.expiresAtMs - payload.issuedAtMs <= this.#maxTtlMs, 'INVALID_GRANT_TTL', 'peer grant TTL exceeds verifier policy');
    const now = this.#clock();
    assert(Number.isFinite(now), 'INVALID_CLOCK', 'clock returned invalid time');
    assert(payload.issuedAtMs <= now + this.#clockSkewMs, 'GRANT_FROM_FUTURE', 'peer grant issuedAt is too far in the future');
    assert(payload.expiresAtMs >= now - this.#clockSkewMs, 'GRANT_EXPIRED', 'peer grant has expired');
    validateSubjectAndSession(payload); assertPayloadMatchesRequest(payload, request);
    for (const [grantId, expiresAt] of this.#used) if (expiresAt < now - this.#clockSkewMs) this.#used.delete(grantId);
    assert(!this.#used.has(payload.grantId), 'GRANT_REPLAYED', 'peer authorization grant has already been consumed');
    this.#used.set(payload.grantId, payload.expiresAtMs);
    return Object.freeze(JSON.parse(JSON.stringify(payload)));
  }
}

export class PeerAuthorizationClient {
  #socketPath; #timeoutMs;
  constructor({ socketPath = DEFAULT_SOCKET, timeoutMs = 35_000 } = {}) {
    assert(typeof socketPath === 'string' && socketPath.startsWith('/'), 'PEER_SOCKET_PATH_INVALID', 'peer authorization socket path must be absolute');
    assert(Number.isInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 60_000, 'PEER_SOCKET_TIMEOUT_INVALID', 'peer socket timeout must be between 1s and 60s');
    this.#socketPath = socketPath; this.#timeoutMs = timeoutMs;
  }
  request(input) {
    const request = cleanExpectedRequest(input);
    const wire = `${JSON.stringify({ schema: REQUEST_SCHEMA, scope: request.scope, planDigest: request.planDigest, allowUserInteraction: request.allowUserInteraction,
      ...(request.domain === 'packages' ? { packageId: request.packageId, operation: request.operation } : {}),
      ...(request.domain === 'network' ? { connectionUuid: request.connectionUuid, ifname: request.ifname, operation: request.operation } : {}),
      ...(request.domain === 'firmware' ? { deviceId: request.deviceId, releaseId: request.releaseId, operation: request.operation } : {}) })}\n`;
    assert(Buffer.byteLength(wire) <= MAX_WIRE_BYTES, 'PEER_REQUEST_TOO_LARGE', 'peer authorization request exceeds wire limit');
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.#socketPath }); let settled = false; let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => finish(new Error('peer authorization request timed out')), this.#timeoutMs);
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(value); };
      socket.once('error', error => finish(error)); socket.once('connect', () => socket.write(wire));
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_WIRE_BYTES) return finish(Object.assign(new Error('peer authorization response too large'), { code: 'PEER_RESPONSE_TOO_LARGE' }));
        const newline = buffer.indexOf(0x0a); if (newline < 0) return;
        const line = buffer.subarray(0, newline).toString('utf8'); let response;
        try { response = JSON.parse(line); } catch (error) { return finish(Object.assign(new Error('peer authorization response is invalid JSON', { cause: error }), { code: 'PEER_RESPONSE_INVALID' })); }
        if (!isObject(response) || response.schema !== RESPONSE_SCHEMA) return finish(Object.assign(new Error('peer authorization response schema is invalid'), { code: 'PEER_RESPONSE_INVALID' }));
        finish(null, Object.freeze(response));
      });
    });
  }
}

function adapterGrant(payload, schema, extra) {
  return Object.freeze({ schema, authorized: true, grantId: payload.grantId, actorId: payload.actorId, actionId: payload.actionId, operation: payload.operation,
    planDigest: payload.planDigest, subject: Object.freeze({ pid: payload.subject.pid, uid: payload.subject.uid, startTime: payload.subject.startTime }), interactive: payload.interactive,
    authorizedAt: new Date(payload.issuedAtMs).toISOString(), peerCredentialBound: true, sessionId: payload.session.id, ...extra });
}

export class PeerPackageAuthorizationBroker {
  #verifier;
  constructor({ verifier } = {}) { assert(verifier && typeof verifier.verify === 'function', 'PEER_GRANT_VERIFIER_REQUIRED', 'verifier.verify is required'); this.#verifier = verifier; }
  async authorize(request) {
    assert(isObject(request) && request.schema === 'swir.system-authorization-request/0.1', 'INVALID_AUTHORIZATION_SCHEMA', 'invalid package authorization request');
    const envelope = request.context?.peerAuthorizationEnvelope; assert(envelope, 'PEER_GRANT_REQUIRED', 'package authorization requires a peer authorization envelope');
    const payload = this.#verifier.verify(envelope, { schema: REQUEST_SCHEMA, scope: request.scope, planDigest: request.planDigest, packageId: request.packageId, operation: request.operation, allowUserInteraction: request.context?.allowUserInteraction === true });
    if (request.context?.actorId !== undefined) assert(request.context.actorId === payload.actorId, 'ACTOR_BINDING_MISMATCH', 'requested actor does not match peer grant');
    return adapterGrant(payload, 'swir.system-authorization-grant/0.1', { scope: payload.scope, packageId: payload.packageId });
  }
}

export class PeerNetworkAuthorizationBroker {
  #verifier;
  constructor({ verifier } = {}) { assert(verifier && typeof verifier.verify === 'function', 'PEER_GRANT_VERIFIER_REQUIRED', 'verifier.verify is required'); this.#verifier = verifier; }
  async authorize(request) {
    assert(isObject(request) && request.schema === 'swir.network-authorization-request/0.1', 'INVALID_AUTHORIZATION_SCHEMA', 'invalid network authorization request');
    const envelope = request.context?.peerAuthorizationEnvelope; assert(envelope, 'PEER_GRANT_REQUIRED', 'network authorization requires a peer authorization envelope');
    const payload = this.#verifier.verify(envelope, { schema: REQUEST_SCHEMA, scope: `network.${request.operation}`, planDigest: request.planDigest, connectionUuid: request.connectionUuid, ifname: request.ifname ?? null, operation: request.operation, allowUserInteraction: request.context?.allowUserInteraction === true });
    if (request.context?.actorId !== undefined) assert(request.context.actorId === payload.actorId, 'ACTOR_BINDING_MISMATCH', 'requested actor does not match peer grant');
    return adapterGrant(payload, 'swir.network-authorization-grant/0.1', { connectionUuid: payload.connectionUuid, ifname: payload.ifname ?? null });
  }
}

export class PeerFirmwareAuthorizationBroker {
  #verifier;
  constructor({ verifier } = {}) { assert(verifier && typeof verifier.verify === 'function', 'PEER_GRANT_VERIFIER_REQUIRED', 'verifier.verify is required'); this.#verifier = verifier; }
  async authorize(request) {
    assert(isObject(request) && request.schema === 'swir.firmware-authorization-request/0.1', 'INVALID_AUTHORIZATION_SCHEMA', 'invalid firmware authorization request');
    const envelope = request.context?.peerAuthorizationEnvelope; assert(envelope, 'PEER_GRANT_REQUIRED', 'firmware authorization requires a peer authorization envelope');
    const payload = this.#verifier.verify(envelope, { schema: REQUEST_SCHEMA, scope: `firmware.${request.operation}`, planDigest: request.planDigest, deviceId: request.deviceId, releaseId: request.releaseId ?? null, operation: request.operation, allowUserInteraction: request.context?.allowUserInteraction === true });
    if (request.context?.actorId !== undefined) assert(request.context.actorId === payload.actorId, 'ACTOR_BINDING_MISMATCH', 'requested actor does not match peer grant');
    return adapterGrant(payload, 'swir.firmware-authorization-grant/0.1', { deviceId: payload.deviceId, releaseId: payload.releaseId ?? null });
  }
}

export const PeerAuthorizationPolicy = Object.freeze({ schema: 'swir.peer-authorization-policy/0.1', transport: 'unix-stream', socketPath: DEFAULT_SOCKET, keyPath: DEFAULT_KEY,
  peerIdentitySource: 'linux-so-peercred', sessionSource: 'systemd-logind-active-local-graphical', privilegeAuthority: 'polkit-pkcheck', hmac: 'hmac-sha256-root-only-runtime-key',
  maxGrantTtlMs: 30_000, oneTimeConsumption: true, callerSuppliedUnixIdentity: false, rootPeerEligible: false, shellExecution: false });
