import fs from 'node:fs';
import { execFile } from 'node:child_process';

const fsp = fs.promises;
const DEFAULT_LOGINCTL = '/usr/bin/loginctl';
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_SESSIONS = 64;
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const USER_NAME = /^[A-Za-z0-9_.@-]{1,128}$/;
const GRAPHICAL_TYPES = new Set(['wayland', 'x11']);
const USER_CLASSES = new Set(['user', 'user-early']);

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'SystemSessionIdentityError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function clean(value, max = 512) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function parseBoolean(value) {
  return String(value ?? '').toLowerCase() === 'yes';
}

function defaultRunner(binary, args, options) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ code: 0, stdout, stderr });
    });
  });
}

function parseProperties(stdout) {
  const text = String(stdout ?? '');
  assert(Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES, 'LOGINCTL_OUTPUT_TOO_LARGE', 'loginctl output exceeded the configured limit');
  const properties = Object.create(null);
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine) continue;
    const index = rawLine.indexOf('=');
    if (index <= 0) continue;
    const key = clean(rawLine.slice(0, index), 96);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) continue;
    properties[key] = clean(rawLine.slice(index + 1), 1024);
  }
  return properties;
}

function normalizeSession(properties) {
  const id = clean(properties.Id, 128);
  const uidText = clean(properties.User, 32);
  const uid = /^[0-9]+$/.test(uidText) ? Number.parseInt(uidText, 10) : null;
  const name = clean(properties.Name, 128);
  const type = clean(properties.Type, 32).toLowerCase() || 'unknown';
  const sessionClass = clean(properties.Class, 32).toLowerCase() || 'unknown';
  const state = clean(properties.State, 32).toLowerCase() || 'unknown';
  const seat = clean(properties.Seat, 128) || null;
  const leaderText = clean(properties.Leader, 32);
  const leaderPid = /^[0-9]+$/.test(leaderText) ? Number.parseInt(leaderText, 10) : null;
  const active = parseBoolean(properties.Active);
  const remote = parseBoolean(properties.Remote);
  const graphical = GRAPHICAL_TYPES.has(type);
  const userClass = USER_CLASSES.has(sessionClass);
  const safeIdentity = Number.isInteger(uid) && uid > 0 && uid <= 0x7fffffff && USER_NAME.test(name);
  const eligible = Boolean(SESSION_ID.test(id) && safeIdentity && active && !remote && state === 'active' && graphical && userClass);
  return Object.freeze({
    id: SESSION_ID.test(id) ? id : null,
    uid,
    username: USER_NAME.test(name) ? name : null,
    actorId: Number.isInteger(uid) && uid >= 0 ? `uid:${uid}` : null,
    active,
    remote,
    state,
    type,
    class: sessionClass,
    seat,
    service: clean(properties.Service, 128) || null,
    display: clean(properties.Display, 128) || null,
    tty: clean(properties.TTY, 128) || null,
    leaderPid,
    graphical,
    eligibleActiveLocalUser: eligible
  });
}

function compareSessions(a, b, preferredSeat) {
  const aSeat = a.seat === preferredSeat ? 1 : 0;
  const bSeat = b.seat === preferredSeat ? 1 : 0;
  if (aSeat !== bSeat) return bSeat - aSeat;
  const typeRank = value => value === 'wayland' ? 2 : value === 'x11' ? 1 : 0;
  const typeDiff = typeRank(b.type) - typeRank(a.type);
  if (typeDiff) return typeDiff;
  return String(a.id).localeCompare(String(b.id));
}

export function selectActiveLocalSession(inventory, { preferredSeat = 'seat0' } = {}) {
  assert(inventory?.schema === 'swir.system-session-inventory/0.1', 'INVALID_SESSION_INVENTORY', 'session inventory schema is invalid');
  const eligible = (inventory.sessions || []).filter(session => session?.eligibleActiveLocalUser === true);
  if (!eligible.length) return null;
  const selected = [...eligible].sort((a, b) => compareSessions(a, b, preferredSeat))[0];
  return Object.freeze({
    schema: 'swir.system-session-actor/0.1',
    actorId: selected.actorId,
    uid: selected.uid,
    username: selected.username,
    sessionId: selected.id,
    seat: selected.seat,
    type: selected.type,
    leaderPid: selected.leaderPid,
    source: 'systemd-logind',
    local: true,
    active: true,
    authenticatedBySessionManager: false
  });
}

export function createSessionBoundAuthorizationContext(actor, { allowUserInteraction = false, currentUid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  assert(actor?.schema === 'swir.system-session-actor/0.1', 'INVALID_SESSION_ACTOR', 'session actor schema is invalid');
  assert(Number.isInteger(actor.uid) && actor.uid > 0, 'INVALID_SESSION_ACTOR', 'session actor uid is invalid');
  assert(actor.actorId === `uid:${actor.uid}`, 'INVALID_SESSION_ACTOR', 'session actor id does not match uid');
  assert(actor.local === true && actor.active === true, 'INACTIVE_SESSION_ACTOR', 'authorization context requires an active local session actor');
  assert(Number.isInteger(currentUid) && currentUid >= 0, 'CURRENT_UID_UNAVAILABLE', 'current Unix uid is unavailable');
  assert(currentUid === actor.uid, 'SESSION_PROCESS_UID_MISMATCH', 'active session actor does not match the current process uid; privileged daemons must use a future peer-credential broker instead of impersonating the session user');
  return Object.freeze({
    actorId: actor.actorId,
    sessionId: actor.sessionId,
    allowUserInteraction: allowUserInteraction === true
  });
}

export class SystemSessionIdentityService {
  #binary;
  #runner;
  #expectedOwnerUid;
  #enforceBinaryTrust;

  constructor({
    binary = DEFAULT_LOGINCTL,
    runner = defaultRunner,
    expectedOwnerUid = 0,
    enforceBinaryTrust = true
  } = {}) {
    assert(binary === DEFAULT_LOGINCTL || enforceBinaryTrust === false, 'LOGINCTL_BINARY_NOT_ALLOWLISTED', 'production session identity is pinned to /usr/bin/loginctl');
    assert(typeof runner === 'function', 'LOGINCTL_RUNNER_REQUIRED', 'loginctl runner must be a function');
    assert(expectedOwnerUid === null || (Number.isInteger(expectedOwnerUid) && expectedOwnerUid >= 0), 'INVALID_OWNER_UID', 'expected owner uid must be a non-negative integer or null');
    this.#binary = binary;
    this.#runner = runner;
    this.#expectedOwnerUid = expectedOwnerUid;
    this.#enforceBinaryTrust = enforceBinaryTrust;
  }

  async probe() {
    if (!this.#enforceBinaryTrust) {
      return Object.freeze({ available: true, trustedBinary: true, binary: this.#binary, testOverride: true });
    }
    let lstat;
    try { lstat = await fsp.lstat(this.#binary); }
    catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ available: false, trustedBinary: false, binary: this.#binary, reason: 'not-installed' });
      throw error;
    }
    assert(lstat.isFile() && !lstat.isSymbolicLink(), 'LOGINCTL_BINARY_INVALID', 'loginctl must be a regular non-symlink file');
    const real = await fsp.realpath(this.#binary);
    assert(real === this.#binary, 'LOGINCTL_BINARY_SYMLINKED', 'loginctl must resolve exactly to the allowlisted distro binary');
    assert((lstat.mode & 0o111) !== 0, 'LOGINCTL_BINARY_NOT_EXECUTABLE', 'loginctl must be executable');
    assert((lstat.mode & 0o022) === 0, 'LOGINCTL_BINARY_WRITABLE', 'loginctl must not be group/world writable');
    if (this.#expectedOwnerUid !== null && typeof lstat.uid === 'number') {
      assert(lstat.uid === this.#expectedOwnerUid, 'LOGINCTL_BINARY_OWNER_INVALID', 'loginctl owner does not match the trusted uid');
    }
    return Object.freeze({ available: true, trustedBinary: true, binary: this.#binary, ownerUid: typeof lstat.uid === 'number' ? lstat.uid : null });
  }

  async #run(args, { timeout = 10_000 } = {}) {
    const probe = await this.probe();
    assert(probe.available, 'LOGIND_UNAVAILABLE', 'systemd-logind client is unavailable');
    const result = await this.#runner(this.#binary, args, {
      shell: false,
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' })
    });
    assert(result && typeof result === 'object', 'LOGINCTL_RESULT_INVALID', 'loginctl runner returned an invalid result');
    if (Number.isInteger(result.code) && result.code !== 0) fail('LOGINCTL_COMMAND_FAILED', `loginctl exited with code ${result.code}`);
    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    assert(Buffer.byteLength(stdout, 'utf8') <= MAX_OUTPUT_BYTES && Buffer.byteLength(stderr, 'utf8') <= MAX_OUTPUT_BYTES, 'LOGINCTL_OUTPUT_TOO_LARGE', 'loginctl output exceeded the configured limit');
    return { code: Number.isInteger(result.code) ? result.code : 0, stdout, stderr };
  }

  async inventory({ preferredSeat = 'seat0' } = {}) {
    const probe = await this.probe();
    if (!probe.available) {
      return Object.freeze({
        schema: 'swir.system-session-inventory/0.1',
        provider: 'systemd-logind',
        available: false,
        readOnly: true,
        mutationCapable: false,
        arbitrarySessionOverride: false,
        secretsExposed: false,
        sessions: [],
        activeActor: null,
        probe
      });
    }

    const listed = await this.#run(['list-sessions', '--no-legend', '--no-pager']);
    const ids = [];
    for (const line of listed.stdout.split(/\r?\n/)) {
      const id = clean(line.trim().split(/\s+/)[0], 128);
      if (!SESSION_ID.test(id) || ids.includes(id)) continue;
      ids.push(id);
      if (ids.length >= MAX_SESSIONS) break;
    }

    const propertyArgs = [
      '--no-pager',
      '--property=Id', '--property=User', '--property=Name', '--property=Remote',
      '--property=Active', '--property=State', '--property=Type', '--property=Class',
      '--property=Seat', '--property=Leader', '--property=Display', '--property=TTY', '--property=Service'
    ];
    const sessions = [];
    for (const id of ids) {
      try {
        const result = await this.#run(['show-session', id, ...propertyArgs]);
        const session = normalizeSession(parseProperties(result.stdout));
        if (session.id === id) sessions.push(session);
      } catch (error) {
        sessions.push(Object.freeze({
          id,
          uid: null,
          username: null,
          actorId: null,
          active: false,
          remote: false,
          state: 'probe-failed',
          type: 'unknown',
          class: 'unknown',
          seat: null,
          service: null,
          display: null,
          tty: null,
          leaderPid: null,
          graphical: false,
          eligibleActiveLocalUser: false,
          probeError: clean(error?.code || error?.message || 'probe-failed', 128)
        }));
      }
    }

    const base = {
      schema: 'swir.system-session-inventory/0.1',
      provider: 'systemd-logind',
      available: true,
      readOnly: true,
      mutationCapable: false,
      arbitrarySessionOverride: false,
      secretsExposed: false,
      sessions: Object.freeze(sessions),
      activeActor: null,
      probe
    };
    return Object.freeze({ ...base, activeActor: selectActiveLocalSession(base, { preferredSeat }) });
  }

  async resolveActiveActor({ preferredSeat = 'seat0', required = true } = {}) {
    const inventory = await this.inventory({ preferredSeat });
    if (!inventory.activeActor && required) fail('NO_ACTIVE_LOCAL_SESSION', 'no active local graphical user session is available');
    return inventory.activeActor;
  }
}

export const SystemSessionIdentityPolicy = Object.freeze({
  schema: 'swir.system-session-identity-policy/0.1',
  provider: 'systemd-logind',
  loginctlPath: DEFAULT_LOGINCTL,
  readOnly: true,
  mutationCapable: false,
  arbitrarySessionOverride: false,
  remoteSessionEligible: false,
  rootSessionEligible: false,
  graphicalTypes: Object.freeze([...GRAPHICAL_TYPES]),
  userClasses: Object.freeze([...USER_CLASSES]),
  shellExecution: false,
  inheritedEnvironment: false,
  secretCollection: false,
  authorizationRule: 'session-attribution-only; current-process uid must match actor uid until a peer-credential service broker exists'
});
