import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const fsp = fs.promises;
const DEFAULT_BINARY = '/usr/bin/loginctl';
const MAX_OUTPUT_BYTES = 512 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const USERNAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const DESKTOP_TYPES = new Set(['wayland', 'x11']);
const USER_CLASSES = new Set(['user', 'user-early']);

function fail(code, message) {
  const error = new Error(message);
  error.name = 'SystemSessionIdentityError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function clean(value, max = 256) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function parseBoolean(value) {
  return String(value ?? '').trim().toLowerCase() === 'yes';
}

function parseInteger(value) {
  const text = String(value ?? '').trim();
  return /^[0-9]+$/.test(text) ? Number.parseInt(text, 10) : null;
}

function parseProperties(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    out[key] = line.slice(index + 1);
  }
  return out;
}

function parseProcStartTime(statText) {
  const text = String(statText || '');
  const end = text.lastIndexOf(') ');
  assert(end > 0, 'PROCESS_PROBE_FAILED', 'could not parse /proc process stat');
  const fields = text.slice(end + 2).trim().split(/\s+/);
  const startTime = fields[19];
  assert(typeof startTime === 'string' && /^[0-9]+$/.test(startTime), 'PROCESS_PROBE_FAILED', 'process start time is unavailable');
  return startTime;
}

function defaultProcessProbe(pid = process.pid) {
  assert(Number.isInteger(pid) && pid > 0, 'PROCESS_PROBE_FAILED', 'process id must be positive');
  assert(typeof process.getuid === 'function', 'UID_UNAVAILABLE', 'System Edition session identity requires a Unix uid');
  const uid = process.getuid();
  assert(Number.isInteger(uid) && uid >= 0, 'UID_UNAVAILABLE', 'current Unix uid is unavailable');
  return {
    pid,
    uid,
    startTime: parseProcStartTime(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
  };
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

function canonicalSession(session, subject) {
  return JSON.stringify({
    sessionId: session.sessionId,
    uid: session.uid,
    username: session.username,
    seat: session.seat,
    type: session.type,
    class: session.class,
    state: session.state,
    active: session.active,
    remote: session.remote,
    leader: session.leader,
    process: { pid: subject.pid, uid: subject.uid, startTime: subject.startTime }
  });
}

function sessionDigest(session, subject) {
  return crypto.createHash('sha256').update(canonicalSession(session, subject), 'utf8').digest('hex');
}

function normalizeSession(properties) {
  const sessionId = clean(properties.Id, 64);
  assert(SESSION_ID.test(sessionId), 'INVALID_SESSION_ID', 'logind returned an invalid session id');
  const uid = parseInteger(properties.User);
  assert(Number.isInteger(uid) && uid >= 0, 'INVALID_SESSION_UID', 'logind returned an invalid session uid');
  const username = clean(properties.Name, 64);
  assert(USERNAME.test(username), 'INVALID_SESSION_USER', 'logind returned an invalid session user');
  const leader = parseInteger(properties.Leader);
  return Object.freeze({
    sessionId,
    uid,
    username,
    seat: clean(properties.Seat, 64) || null,
    type: clean(properties.Type, 32).toLowerCase() || 'unspecified',
    class: clean(properties.Class, 32).toLowerCase() || 'unspecified',
    state: clean(properties.State, 32).toLowerCase() || 'unknown',
    active: parseBoolean(properties.Active),
    remote: parseBoolean(properties.Remote),
    leader: Number.isInteger(leader) && leader > 0 ? leader : null,
    display: clean(properties.Display, 128) || null,
    tty: clean(properties.TTY, 128) || null
  });
}

export class SystemSessionIdentityService {
  #binary;
  #runner;
  #processProbe;
  #expectedOwnerUid;
  #enforceBinaryTrust;
  #clock;

  constructor({
    binary = DEFAULT_BINARY,
    runner = defaultRunner,
    processProbe = defaultProcessProbe,
    expectedOwnerUid = 0,
    enforceBinaryTrust = true,
    clock = () => new Date().toISOString()
  } = {}) {
    assert(binary === DEFAULT_BINARY || enforceBinaryTrust === false, 'LOGINCTL_BINARY_NOT_ALLOWLISTED', 'Production session identity is pinned to /usr/bin/loginctl');
    assert(typeof runner === 'function', 'SESSION_RUNNER_REQUIRED', 'runner must be a function');
    assert(typeof processProbe === 'function', 'PROCESS_PROBE_REQUIRED', 'processProbe must be a function');
    assert(expectedOwnerUid === null || (Number.isInteger(expectedOwnerUid) && expectedOwnerUid >= 0), 'INVALID_OWNER_UID', 'expectedOwnerUid must be a non-negative integer or null');
    assert(typeof clock === 'function', 'CLOCK_REQUIRED', 'clock must be a function');
    this.#binary = binary;
    this.#runner = runner;
    this.#processProbe = processProbe;
    this.#expectedOwnerUid = expectedOwnerUid;
    this.#enforceBinaryTrust = enforceBinaryTrust;
    this.#clock = clock;
  }

  async probe() {
    if (!this.#enforceBinaryTrust) return Object.freeze({ available: true, binary: this.#binary, trustedBinary: true, testOverride: true });
    let stat;
    try { stat = await fsp.lstat(this.#binary); }
    catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ available: false, binary: this.#binary, trustedBinary: false, reason: 'not-installed' });
      throw error;
    }
    assert(stat.isFile() && !stat.isSymbolicLink(), 'LOGINCTL_BINARY_INVALID', 'loginctl must be a regular non-symlink file');
    const real = await fsp.realpath(this.#binary);
    assert(real === this.#binary, 'LOGINCTL_BINARY_SYMLINKED', 'loginctl must resolve exactly to the allowlisted distro binary');
    assert((stat.mode & 0o111) !== 0, 'LOGINCTL_BINARY_NOT_EXECUTABLE', 'loginctl must be executable');
    assert((stat.mode & 0o022) === 0, 'LOGINCTL_BINARY_WRITABLE', 'loginctl must not be writable by group or others');
    if (this.#expectedOwnerUid !== null && typeof stat.uid === 'number') {
      assert(stat.uid === this.#expectedOwnerUid, 'LOGINCTL_BINARY_OWNER_INVALID', 'loginctl owner does not match the trusted UID');
    }
    return Object.freeze({ available: true, binary: this.#binary, trustedBinary: true, ownerUid: typeof stat.uid === 'number' ? stat.uid : null });
  }

  async #run(args, { timeout = 10_000 } = {}) {
    const probe = await this.probe();
    assert(probe.available, 'SYSTEMD_LOGIND_UNAVAILABLE', 'systemd loginctl is not installed on this host');
    const result = await this.#runner(this.#binary, args, {
      shell: false,
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
    });
    assert(result && typeof result === 'object', 'LOGINCTL_RESULT_INVALID', 'loginctl runner returned invalid result');
    if (Number.isInteger(result.code) && result.code !== 0) fail('LOGINCTL_COMMAND_FAILED', `loginctl exited with code ${result.code}`);
    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    assert(Buffer.byteLength(stdout, 'utf8') <= MAX_OUTPUT_BYTES && Buffer.byteLength(stderr, 'utf8') <= MAX_OUTPUT_BYTES, 'LOGINCTL_OUTPUT_TOO_LARGE', 'loginctl output exceeded the configured limit');
    return { stdout, stderr, code: Number.isInteger(result.code) ? result.code : 0 };
  }

  async listSessions() {
    const listed = await this.#run(['list-sessions', '--no-legend', '--no-pager']);
    const ids = [];
    for (const line of listed.stdout.split(/\r?\n/)) {
      const id = clean(line.trim().split(/\s+/)[0], 64);
      if (!id) continue;
      assert(SESSION_ID.test(id), 'INVALID_SESSION_ID', 'loginctl list-sessions returned an invalid session id');
      if (!ids.includes(id)) ids.push(id);
      assert(ids.length <= 64, 'TOO_MANY_SESSIONS', 'session inventory exceeded the configured limit');
    }

    const sessions = [];
    for (const id of ids) {
      const shown = await this.#run([
        'show-session', id, '--no-pager',
        '--property=Id', '--property=User', '--property=Name', '--property=Seat',
        '--property=Remote', '--property=Active', '--property=State', '--property=Type',
        '--property=Class', '--property=Leader', '--property=Display', '--property=TTY'
      ]);
      sessions.push(normalizeSession(parseProperties(shown.stdout)));
    }
    return Object.freeze(sessions);
  }

  async inventory() {
    const probe = await this.probe();
    if (!probe.available) return Object.freeze({ schema: 'swir.system-session-inventory/0.1', available: false, readOnly: true, sessions: [], probe });
    const sessions = await this.listSessions();
    return Object.freeze({ schema: 'swir.system-session-inventory/0.1', available: true, readOnly: true, sessions, probe });
  }

  async resolveActiveLocalDesktopSession({ uid = null } = {}) {
    assert(uid === null || (Number.isInteger(uid) && uid >= 0), 'INVALID_SESSION_UID_FILTER', 'uid filter must be a non-negative integer or null');
    const sessions = await this.listSessions();
    const matches = sessions.filter(session =>
      session.remote === false &&
      session.active === true &&
      DESKTOP_TYPES.has(session.type) &&
      USER_CLASSES.has(session.class) &&
      (uid === null || session.uid === uid)
    );
    if (matches.length === 0) return null;
    assert(matches.length === 1, 'AMBIGUOUS_ACTIVE_DESKTOP_SESSION', 'more than one active local desktop session matched the request');
    return matches[0];
  }

  async attestCurrentProcess({ actorId = null } = {}) {
    const subject = await this.#processProbe(process.pid);
    assert(subject && typeof subject === 'object', 'PROCESS_PROBE_FAILED', 'process probe returned invalid result');
    assert(Number.isInteger(subject.pid) && subject.pid > 0, 'PROCESS_PROBE_FAILED', 'process probe returned invalid pid');
    assert(Number.isInteger(subject.uid) && subject.uid >= 0, 'PROCESS_PROBE_FAILED', 'process probe returned invalid uid');
    assert(typeof subject.startTime === 'string' && /^[0-9]+$/.test(subject.startTime), 'PROCESS_PROBE_FAILED', 'process probe returned invalid start time');
    const expectedActorId = `uid:${subject.uid}`;
    if (actorId !== null) assert(actorId === expectedActorId, 'ACTOR_BINDING_MISMATCH', 'requested actor does not match the current Unix process uid');

    const session = await this.resolveActiveLocalDesktopSession({ uid: subject.uid });
    assert(session, 'ACTIVE_DESKTOP_SESSION_NOT_FOUND', 'current Unix uid has no unique active local graphical logind session');
    const digest = sessionDigest(session, subject);
    return Object.freeze({
      schema: 'swir.system-session-attestation/0.1',
      actorId: expectedActorId,
      sessionActorId: `session:${session.sessionId}:uid:${session.uid}`,
      sessionId: session.sessionId,
      uid: session.uid,
      username: session.username,
      seat: session.seat,
      type: session.type,
      class: session.class,
      state: session.state,
      active: session.active,
      remote: session.remote,
      leader: session.leader,
      processSubject: Object.freeze({ pid: subject.pid, uid: subject.uid, startTime: subject.startTime }),
      sessionDigest: digest,
      attestedAt: this.#clock(),
      authority: 'systemd-logind-read-only',
      authorizationAuthority: 'polkit-separate'
    });
  }
}

export const SystemSessionIdentityPolicy = Object.freeze({
  schema: 'swir.system-session-attestation/0.1',
  provider: 'systemd-logind',
  binary: DEFAULT_BINARY,
  readOnly: true,
  activeLocalDesktopRequired: true,
  remoteSessionsAccepted: false,
  supportedDesktopTypes: Object.freeze([...DESKTOP_TYPES]),
  arbitraryUidOverride: false,
  arbitrarySessionOverride: false,
  shellExecution: false,
  inheritedEnvironment: false,
  authorizationAuthority: 'polkit-separate'
});