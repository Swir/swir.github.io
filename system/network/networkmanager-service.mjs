import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const fsp = fs.promises;
const DEFAULT_BINARY = '/usr/bin/nmcli';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IFNAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const NETWORK_STATES = new Set(['unknown', 'asleep', 'disconnected', 'disconnecting', 'connecting', 'connected-local', 'connected-site', 'connected-global', 'connected']);

function fail(code, message) {
  const error = new Error(message);
  error.name = 'NetworkManagerServiceError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function clean(value, max = 512) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function safeUuid(value) {
  const normalized = String(value ?? '').trim();
  assert(UUID.test(normalized), 'INVALID_CONNECTION_UUID', 'connection UUID is invalid');
  return normalized.toLowerCase();
}

function safeIfname(value, { optional = true } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  const normalized = String(value ?? '').trim();
  assert(IFNAME.test(normalized), 'INVALID_INTERFACE_NAME', 'interface name contains unsupported characters');
  return normalized;
}

function splitEscaped(line, separator = ':') {
  const values = [];
  let current = '';
  let escaped = false;
  for (const char of String(line ?? '')) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === separator) {
      values.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  values.push(current);
  return values;
}

function rows(stdout, expectedFields) {
  const text = String(stdout ?? '');
  assert(Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES, 'NMCLI_OUTPUT_TOO_LARGE', 'nmcli output exceeded the configured limit');
  return text
    .split(/\r?\n/)
    .filter(line => line.length > 0)
    .map(line => {
      const values = splitEscaped(line);
      while (values.length < expectedFields) values.push('');
      if (values.length > expectedFields) {
        values.splice(expectedFields - 1, values.length - expectedFields + 1, values.slice(expectedFields - 1).join(':'));
      }
      return values.map(value => clean(value));
    });
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

function canonicalPlan(plan) {
  return JSON.stringify({
    schema: plan.schema,
    operation: plan.operation,
    connectionUuid: plan.connectionUuid,
    ifname: plan.ifname,
    command: plan.command,
    expectedPostcondition: plan.expectedPostcondition
  });
}

function digestPlan(plan) {
  return crypto.createHash('sha256').update(canonicalPlan(plan), 'utf8').digest('hex');
}

function normalizeDevice(values) {
  const [device, type, state, connection] = values;
  return Object.freeze({
    ifname: device || null,
    type: type || 'unknown',
    state: state || 'unknown',
    connection: connection && connection !== '--' ? connection : null
  });
}

function normalizeConnection(values) {
  const [name, uuid, type, device] = values;
  return Object.freeze({
    name: name || 'Unnamed connection',
    uuid: UUID.test(uuid) ? uuid.toLowerCase() : null,
    type: type || 'unknown',
    ifname: device && device !== '--' ? device : null,
    active: Boolean(device && device !== '--')
  });
}

function normalizeAccessPoint(values) {
  const [inUse, bssid, ssid, signal, security, device] = values;
  const parsedSignal = Number.parseInt(signal, 10);
  return Object.freeze({
    inUse: inUse === '*' || inUse.toLowerCase() === 'yes',
    bssid: bssid || null,
    ssid: ssid || '',
    signal: Number.isInteger(parsedSignal) ? Math.max(0, Math.min(100, parsedSignal)) : null,
    security: security && security !== '--' ? security : null,
    ifname: device || null,
    secretExposed: false
  });
}

export class NetworkManagerService {
  #binary;
  #runner;
  #authorizer;
  #expectedOwnerUid;
  #enforceBinaryTrust;

  constructor({
    binary = DEFAULT_BINARY,
    runner = defaultRunner,
    authorizer = null,
    expectedOwnerUid = 0,
    enforceBinaryTrust = true
  } = {}) {
    assert(binary === DEFAULT_BINARY || enforceBinaryTrust === false, 'NMCLI_BINARY_NOT_ALLOWLISTED', 'Production NetworkManager integration is pinned to /usr/bin/nmcli');
    assert(typeof runner === 'function', 'NMCLI_RUNNER_REQUIRED', 'nmcli runner must be a function');
    assert(authorizer === null || typeof authorizer?.authorize === 'function', 'NETWORK_AUTHORIZER_INVALID', 'authorizer must expose authorize(request)');
    assert(expectedOwnerUid === null || (Number.isInteger(expectedOwnerUid) && expectedOwnerUid >= 0), 'INVALID_OWNER_UID', 'expectedOwnerUid must be a non-negative integer or null');
    this.#binary = binary;
    this.#runner = runner;
    this.#authorizer = authorizer;
    this.#expectedOwnerUid = expectedOwnerUid;
    this.#enforceBinaryTrust = enforceBinaryTrust;
  }

  async probe() {
    if (!this.#enforceBinaryTrust) {
      return Object.freeze({ available: true, binary: this.#binary, trustedBinary: true, testOverride: true });
    }
    let stat;
    try { stat = await fsp.lstat(this.#binary); } catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ available: false, binary: this.#binary, trustedBinary: false, reason: 'not-installed' });
      throw error;
    }
    assert(stat.isFile() && !stat.isSymbolicLink(), 'NMCLI_BINARY_INVALID', 'nmcli must be a regular non-symlink file');
    const real = await fsp.realpath(this.#binary);
    assert(real === this.#binary, 'NMCLI_BINARY_SYMLINKED', 'nmcli must resolve exactly to the allowlisted distro binary');
    assert((stat.mode & 0o111) !== 0, 'NMCLI_BINARY_NOT_EXECUTABLE', 'nmcli must be executable');
    assert((stat.mode & 0o022) === 0, 'NMCLI_BINARY_WRITABLE', 'nmcli must not be writable by group or others');
    if (this.#expectedOwnerUid !== null && typeof stat.uid === 'number') {
      assert(stat.uid === this.#expectedOwnerUid, 'NMCLI_BINARY_OWNER_INVALID', 'nmcli owner does not match the trusted UID');
    }
    return Object.freeze({ available: true, binary: this.#binary, trustedBinary: true, ownerUid: typeof stat.uid === 'number' ? stat.uid : null });
  }

  async #run(args, { timeout = 15_000 } = {}) {
    const probe = await this.probe();
    assert(probe.available, 'NETWORKMANAGER_UNAVAILABLE', 'NetworkManager nmcli is not installed on this host');
    const result = await this.#runner(this.#binary, args, {
      shell: false,
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
    });
    assert(result && typeof result === 'object', 'NMCLI_RESULT_INVALID', 'nmcli runner returned an invalid result');
    if (Number.isInteger(result.code) && result.code !== 0) fail('NMCLI_COMMAND_FAILED', `nmcli exited with code ${result.code}`);
    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    assert(Buffer.byteLength(stdout, 'utf8') <= MAX_OUTPUT_BYTES && Buffer.byteLength(stderr, 'utf8') <= MAX_OUTPUT_BYTES, 'NMCLI_OUTPUT_TOO_LARGE', 'nmcli output exceeded the configured limit');
    return { stdout, stderr, code: Number.isInteger(result.code) ? result.code : 0 };
  }

  async inventory({ includeWifi = true } = {}) {
    const probe = await this.probe();
    if (!probe.available) {
      return Object.freeze({
        schema: 'swir.networkmanager-inventory/0.1',
        available: false,
        provider: 'NetworkManager',
        mutationCapable: false,
        secretsExposed: false,
        general: null,
        devices: [],
        connections: [],
        accessPoints: [],
        probe
      });
    }

    const [generalResult, deviceResult, connectionResult, wifiResult] = await Promise.all([
      this.#run(['--terse', '--escape', 'yes', '--fields', 'STATE,CONNECTIVITY,WIFI-HW,WIFI,WWAN-HW,WWAN', 'general', 'status']),
      this.#run(['--terse', '--escape', 'yes', '--fields', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']),
      this.#run(['--terse', '--escape', 'yes', '--fields', 'NAME,UUID,TYPE,DEVICE', 'connection', 'show']),
      includeWifi
        ? this.#run(['--terse', '--escape', 'yes', '--fields', 'IN-USE,BSSID,SSID,SIGNAL,SECURITY,DEVICE', 'device', 'wifi', 'list', '--rescan', 'no']).catch(error => ({ stdout: '', stderr: String(error?.message || ''), code: 1 }))
        : Promise.resolve({ stdout: '', stderr: '', code: 0 })
    ]);

    const generalRows = rows(generalResult.stdout, 6);
    const [state = 'unknown', connectivity = 'unknown', wifiHardware = 'unknown', wifi = 'unknown', wwanHardware = 'unknown', wwan = 'unknown'] = generalRows[0] || [];
    const normalizedState = clean(state || 'unknown', 64).toLowerCase();
    const general = Object.freeze({
      state: NETWORK_STATES.has(normalizedState) ? normalizedState : (normalizedState || 'unknown'),
      connectivity: clean(connectivity || 'unknown', 64).toLowerCase(),
      wifiHardware: clean(wifiHardware || 'unknown', 32).toLowerCase(),
      wifi: clean(wifi || 'unknown', 32).toLowerCase(),
      wwanHardware: clean(wwanHardware || 'unknown', 32).toLowerCase(),
      wwan: clean(wwan || 'unknown', 32).toLowerCase()
    });

    const devices = rows(deviceResult.stdout, 4).map(normalizeDevice);
    const connections = rows(connectionResult.stdout, 4).map(normalizeConnection).filter(item => item.uuid);
    const accessPoints = includeWifi ? rows(wifiResult.stdout, 6).map(normalizeAccessPoint) : [];

    return Object.freeze({
      schema: 'swir.networkmanager-inventory/0.1',
      available: true,
      provider: 'NetworkManager',
      mutationCapable: Boolean(this.#authorizer),
      secretsExposed: false,
      general,
      devices,
      connections,
      accessPoints,
      wifiScanFailed: includeWifi && wifiResult.code !== 0,
      probe
    });
  }

  planActivation({ connectionUuid, ifname = null } = {}) {
    const uuid = safeUuid(connectionUuid);
    const iface = safeIfname(ifname);
    const command = ['connection', 'up', 'uuid', uuid];
    if (iface) command.push('ifname', iface);
    const plan = Object.freeze({
      schema: 'swir.networkmanager-plan/0.1',
      operation: 'activate',
      connectionUuid: uuid,
      ifname: iface,
      command: Object.freeze([...command]),
      expectedPostcondition: 'connection-active'
    });
    return Object.freeze({ ...plan, digest: digestPlan(plan) });
  }

  planDeactivation({ connectionUuid } = {}) {
    const uuid = safeUuid(connectionUuid);
    const plan = Object.freeze({
      schema: 'swir.networkmanager-plan/0.1',
      operation: 'deactivate',
      connectionUuid: uuid,
      ifname: null,
      command: Object.freeze(['connection', 'down', 'uuid', uuid]),
      expectedPostcondition: 'connection-inactive'
    });
    return Object.freeze({ ...plan, digest: digestPlan(plan) });
  }

  async #authorizedExecute(plan, { actorId, allowUserInteraction = false } = {}) {
    assert(this.#authorizer, 'NETWORK_MUTATION_DISABLED', 'Network mutation requires a configured authorization broker');
    const savedResult = await this.#run(['--terse', '--escape', 'yes', '--fields', 'UUID', 'connection', 'show']);
    const saved = new Set(rows(savedResult.stdout, 1).map(([uuid]) => String(uuid || '').toLowerCase()).filter(value => UUID.test(value)));
    assert(saved.has(plan.connectionUuid), 'NETWORK_CONNECTION_NOT_FOUND', 'requested saved connection profile does not exist');
    const grant = await this.#authorizer.authorize({
      schema: 'swir.network-authorization-request/0.1',
      operation: plan.operation,
      connectionUuid: plan.connectionUuid,
      ifname: plan.ifname,
      planDigest: plan.digest,
      context: { ...(actorId ? { actorId } : {}), allowUserInteraction: allowUserInteraction === true }
    });
    assert(grant?.schema === 'swir.network-authorization-grant/0.1', 'NETWORK_AUTHORIZATION_INVALID', 'authorization broker returned an unexpected schema');
    assert(grant.authorized === true, 'NETWORK_AUTHORIZATION_DENIED', `Network ${plan.operation} authorization was denied`);
    assert(grant.planDigest === plan.digest && grant.connectionUuid === plan.connectionUuid && grant.operation === plan.operation, 'NETWORK_AUTHORIZATION_BINDING_MISMATCH', 'authorization grant is not bound to the requested network plan');
    if (plan.ifname) assert(grant.ifname === plan.ifname, 'NETWORK_AUTHORIZATION_BINDING_MISMATCH', 'authorization grant is not bound to the requested interface');

    await this.#run(['--wait', '45', ...plan.command], { timeout: 50_000 });
    const activeResult = await this.#run(['--terse', '--escape', 'yes', '--fields', 'UUID', 'connection', 'show', '--active']);
    const active = new Set(rows(activeResult.stdout, 1).map(([uuid]) => String(uuid || '').toLowerCase()).filter(value => UUID.test(value)));
    const isActive = active.has(plan.connectionUuid);
    assert(plan.operation === 'activate' ? isActive : !isActive, 'NETWORK_POSTCONDITION_FAILED', `Network ${plan.operation} completed without the expected active-connection state`);

    return Object.freeze({
      schema: 'swir.networkmanager-mutation-result/0.1',
      operation: plan.operation,
      connectionUuid: plan.connectionUuid,
      ifname: plan.ifname,
      planDigest: plan.digest,
      authorizedBy: grant.actionId,
      actorId: grant.actorId,
      postconditionVerified: true,
      active: isActive
    });
  }

  async activateExistingProfile(input, context = {}) {
    return this.#authorizedExecute(this.planActivation(input), context);
  }

  async deactivateProfile(input, context = {}) {
    return this.#authorizedExecute(this.planDeactivation(input), context);
  }
}

export function assertSafeNetworkManagerInventory(inventory) {
  assert(inventory?.schema === 'swir.networkmanager-inventory/0.1', 'NETWORK_INVENTORY_SCHEMA_INVALID', 'NetworkManager inventory schema mismatch');
  assert(inventory.secretsExposed === false, 'NETWORK_SECRET_EXPOSURE', 'NetworkManager inventory must never expose connection secrets');
  for (const connection of inventory.connections || []) {
    assert(typeof connection.uuid === 'string' && UUID.test(connection.uuid), 'NETWORK_CONNECTION_UUID_INVALID', 'NetworkManager connection UUID is invalid');
  }
  for (const accessPoint of inventory.accessPoints || []) {
    assert(accessPoint.secretExposed === false, 'NETWORK_WIFI_SECRET_EXPOSURE', 'Wi-Fi inventory must never expose secrets');
  }
  return true;
}

export const NetworkManagerPolicy = Object.freeze({
  schema: 'swir.networkmanager-policy/0.1',
  binary: DEFAULT_BINARY,
  readOnlyInventory: true,
  mutationOperations: Object.freeze(['activate-existing-profile', 'deactivate-profile']),
  createProfile: false,
  modifyProfile: false,
  deleteProfile: false,
  showSecrets: false,
  rawArguments: false,
  shell: false,
  authorizationRequired: true,
  planDigestRequired: true,
  postconditionVerification: true
});
