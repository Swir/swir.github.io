import fs from 'node:fs';
import { execFile } from 'node:child_process';

const fsp = fs.promises;
const DEFAULT_BINARY = '/usr/bin/loginctl';
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const SEAT = /^[A-Za-z0-9_.:-]{1,64}$/;
const USER_NAME = /^[A-Za-z0-9_.@-]{1,128}$/;
const GRAPHICAL_TYPES = new Set(['x11', 'wayland']);
const USER_CLASSES = new Set(['user', 'user-early']);

export class SystemSessionIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SystemSessionIdentityError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SystemSessionIdentityError(code, message);
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function clean(value, max = 256) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function bool(value) {
  return String(value ?? '').toLowerCase() === 'yes' || String(value ?? '').toLowerCase() === 'true' || String(value ?? '') === '1';
}

function parseProperties(text) {
  const out = Object.create(null);
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    out[line.slice(0, index)] = line.slice(index + 1);
  }
  return out;
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
      resolve({ stdout, stderr, code: 0 });
    });
  });
}

function normalizeSession(properties, minimumUid) {
  const id = clean(properties.Id, 64);
  const uid = Number.parseInt(properties.User, 10);
  const userName = clean(properties.Name, 128);
  const seat = clean(properties.Seat, 64) || null;
  const type = clean(properties.Type, 32).toLowerCase() || 'unknown';
  const state = clean(properties.State, 32).toLowerCase() || 'unknown';
  const remote = bool(properties.Remote);
  const active = bool(properties.Active);
  const locked = bool(properties.LockedHint);
  const sessionClass = clean(properties.Class, 32).toLowerCase() || 'unknown';
  const display = clean(properties.Display, 128) || null;

  assert(SESSION_ID.test(id), 'INVALID_SESSION_ID', 'loginctl returned an invalid session id');
  assert(Number.isInteger(uid) && uid >= 0, 'INVALID_SESSION_UID', 'loginctl returned an invalid session uid');
  assert(!userName || USER_NAME.test(userName), 'INVALID_SESSION_USER', 'loginctl returned an unsafe user name');
  if (seat !== null) assert(SEAT.test(seat), 'INVALID_SESSION_SEAT', 'loginctl returned an invalid seat');

  const localUser = !remote && USER_CLASSES.has(sessionClass) && uid >= minimumUid;
  const graphical = GRAPHICAL_TYPES.has(type);
  const eligible = localUser && active && state === 'active';

  return Object.freeze({
    id,
    uid,
    actorId: `uid:${uid}`,
    userName: userName || null,
    seat,
    type,
    state,
    sessionClass,
    display,
    remote,
    active,
    locked,
    localUser,
    graphical,
    eligible
  });
}

export class SystemSessionIdentityService {
  #binary;
  #runner;
  #expectedOwnerUid;
  #enforceBinaryTrust;
  #minimumUid;

  constructor({
    binary = DEFAULT_BINARY,
    runner = defaultRunner,
    expectedOwnerUid = 0,
    enforceBinaryTrust = true,
    minimumUid = 1000
  } = {}) {
    assert(binary === DEFAULT_BINARY || enforceBinaryTrust === false, 'LOGINCTL_BINARY_NOT_ALLOWLISTED', 'production session identity is pinned to /usr/bin/loginctl');
    assert(typeof runner === 'function', 'LOGINCTL_RUNNER_REQUIRED', 'runner must be a function');
    assert(expectedOwnerUid === null || (Number.isInteger(expectedOwnerUid) && expectedOwnerUid >= 0), 'INVALID_OWNER_UID', 'expectedOwnerUid must be a non-negative integer or null');
    assert(Number.isInteger(minimumUid) && minimumUid >= 0, 'INVALID_MINIMUM_UID', 'minimumUid must be a non-negative integer');
    this.#binary = binary;
    this.#runner = runner;
    this.#expectedOwnerUid = expectedOwnerUid;
    this.#enforceBinaryTrust = enforceBinaryTrust;
    this.#minimumUid = minimumUid;
  }

  async probe() {
    if (!this.#enforceBinaryTrust) {
      return Object.freeze({ available: true, trustedBinary: true, binary: this.#binary, testOverride: true });
    }
    let stat;
    try {
      stat = await fsp.lstat(this.#binary);
    } catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ available: false, trustedBinary: false, binary: this.#binary, reason: 'not-installed' });
      throw error;
    }
    assert(stat.isFile() && !stat.isSymbolicLink(), 'LOGINCTL_BINARY_INVALID', 'loginctl must be a regular non-symlink file');
    const real = await fsp.realpath(this.#binary);
    assert(real === this.#binary, 'LOGINCTL_BINARY_SYMLINKED', 'loginctl must resolve exactly to the allowlisted distro binary');
    assert((stat.mode & 0o111) !== 0, 'LOGINCTL_BINARY_NOT_EXECUTABLE', 'loginctl must be executable');
    assert((stat.mode & 0o022) === 0, 'LOGINCTL_BINARY_WRITABLE', 'loginctl must not be writable by group or others');
    if (this.#expectedOwnerUid !== null && typeof stat.uid === 'number') {
      assert(stat.uid === this.#expectedOwnerUid, 'LOGINCTL_BINARY_OWNER_INVALID', 'loginctl owner does not match the trusted uid');
    }
    return Object.freeze({ available: true, trustedBinary: true, binary: this.#binary, realPath: real, ownerUid: typeof stat.uid === 'number' ? stat.uid : null });
  }

  async #run(args, { timeout = 10_000 } = {}) {
    const probe = await this.probe();
    assert(probe.available, 'LOGIND_UNAVAILABLE', 'systemd-loginctl is not available');
    let result;
    try {
      result = await this.#runner(this.#binary, args, {
        shell: false,
        timeout,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
      });
    } catch (error) {
      throw new SystemSessionIdentityError('LOGINCTL_COMMAND_FAILED', `loginctl command failed: ${clean(error?.message || 'unknown error', 256)}`);
    }
    assert(result && typeof result === 'object', 'LOGINCTL_RESULT_INVALID', 'loginctl runner returned an invalid result');
    if (Number.isInteger(result.code) && result.code !== 0) fail('LOGINCTL_COMMAND_FAILED', `loginctl exited with code ${result.code}`);
    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    assert(Buffer.byteLength(stdout, 'utf8') <= MAX_OUTPUT_BYTES && Buffer.byteLength(stderr, 'utf8') <= MAX_OUTPUT_BYTES, 'LOGINCTL_OUTPUT_TOO_LARGE', 'loginctl output exceeded the configured limit');
    return { stdout, stderr, code: Number.isInteger(result.code) ? result.code : 0 };
  }

  async inventory() {
    const probe = await this.probe();
    if (!probe.available) {
      return Object.freeze({
        schema: 'swir.system-session-inventory/0.1',
        readOnly: true,
        provider: 'systemd-logind',
        available: false,
        secretsExposed: false,
        sessions: [],
        probe
      });
    }

    const listed = await this.#run(['list-sessions', '--no-legend', '--no-pager']);
    const ids = [];
    for (const line of listed.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const id = trimmed.split(/\s+/, 1)[0];
      if (!SESSION_ID.test(id)) continue;
      if (!ids.includes(id)) ids.push(id);
    }

    const sessions = [];
    for (const id of ids) {
      const details = await this.#run([
        'show-session', id, '--no-pager',
        '--property=Id', '--property=User', '--property=Name', '--property=Remote',
        '--property=Active', '--property=State', '--property=Class', '--property=Type',
        '--property=Seat', '--property=Display', '--property=LockedHint'
      ]);
      sessions.push(normalizeSession(parseProperties(details.stdout), this.#minimumUid));
    }

    return Object.freeze({
      schema: 'swir.system-session-inventory/0.1',
      readOnly: true,
      provider: 'systemd-logind',
      available: true,
      secretsExposed: false,
      generatedAt: new Date().toISOString(),
      sessions: Object.freeze(sessions),
      probe
    });
  }

  async resolveActiveSession({ seat = 'seat0', requireGraphical = true } = {}) {
    assert(SEAT.test(String(seat ?? '')), 'INVALID_SESSION_SEAT', 'requested seat is invalid');
    const inventory = await this.inventory();
    assert(inventory.available, 'LOGIND_UNAVAILABLE', 'systemd-logind session inventory is unavailable');
    const candidates = inventory.sessions.filter(session => session.eligible && session.seat === seat && (!requireGraphical || session.graphical));
    if (candidates.length === 0) fail('NO_ACTIVE_LOCAL_SESSION', `no eligible active local ${requireGraphical ? 'graphical ' : ''}session exists on ${seat}`);
    if (candidates.length > 1) fail('AMBIGUOUS_ACTIVE_SESSION', `multiple eligible active sessions exist on ${seat}`);
    const session = candidates[0];
    return Object.freeze({
      schema: 'swir.system-session-identity/0.1',
      provider: 'systemd-logind',
      readOnly: true,
      actorId: session.actorId,
      uid: session.uid,
      userName: session.userName,
      sessionId: session.id,
      seat: session.seat,
      type: session.type,
      display: session.display,
      locked: session.locked,
      remote: false,
      graphical: session.graphical
    });
  }

  async assertActorBinding({ actorId, sessionId, seat = 'seat0', requireGraphical = true } = {}) {
    assert(typeof actorId === 'string' && /^uid:[0-9]+$/.test(actorId), 'INVALID_ACTOR_ID', 'actorId must use uid:<number> form');
    assert(typeof sessionId === 'string' && SESSION_ID.test(sessionId), 'INVALID_SESSION_ID', 'sessionId is invalid');
    const active = await this.resolveActiveSession({ seat, requireGraphical });
    assert(active.actorId === actorId, 'SESSION_ACTOR_MISMATCH', 'actor does not match the active local session');
    assert(active.sessionId === sessionId, 'SESSION_ID_MISMATCH', 'session id does not match the active local session');
    return active;
  }
}

export const SystemSessionIdentityPolicy = Object.freeze({
  schema: 'swir.system-session-identity/0.1',
  provider: 'systemd-logind',
  productionBinary: DEFAULT_BINARY,
  readOnly: true,
  minimumUid: 1000,
  remoteSessionsEligible: false,
  arbitraryUserSelection: false,
  graphicalTypes: Object.freeze([...GRAPHICAL_TYPES]),
  secretsExposed: false,
  authenticationPerformed: false,
  privilegeGranted: false
});
