import fs from 'node:fs';
import { execFile } from 'node:child_process';

const fsp = fs.promises;
const DEFAULT_BINARY = '/usr/bin/fwupdmgr';
const SAFE_COMMANDS = new Set(['get-devices', 'get-updates']);
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function fail(code, message) {
  const error = new Error(message);
  error.name = 'FwupdLvfsServiceError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function text(value, max = 512) {
  const normalized = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized.slice(0, max);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function parseJson(stdout, command) {
  assert(typeof stdout === 'string' && stdout.length <= MAX_OUTPUT_BYTES, 'FWUPD_OUTPUT_INVALID', `${command} returned invalid or excessive output`);
  let parsed;
  try { parsed = JSON.parse(stdout || '{}'); } catch { fail('FWUPD_JSON_INVALID', `${command} did not return valid JSON`); }
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'FWUPD_JSON_INVALID', `${command} JSON root must be an object`);
  return parsed;
}

function normalizeDevice(device) {
  return {
    deviceId: text(device?.DeviceId, 128) || null,
    name: text(device?.Name, 256) || 'Unknown device',
    vendor: text(device?.Vendor, 256) || null,
    version: text(device?.Version, 128) || null,
    versionFormat: text(device?.VersionFormat, 64) || null,
    plugin: text(device?.Plugin, 128) || null,
    guids: list(device?.Guid).map(item => text(item, 128)).filter(Boolean),
    flags: list(device?.Flags).map(item => text(item, 128)).filter(Boolean),
    updateState: Number.isInteger(device?.UpdateState) ? device.UpdateState : null,
    updateError: text(device?.UpdateError, 1024) || null
  };
}

function releasesFromDevice(device) {
  return list(device?.Releases).map(release => ({
    deviceId: text(device?.DeviceId, 128) || null,
    deviceName: text(device?.Name, 256) || 'Unknown device',
    currentVersion: text(device?.Version, 128) || null,
    version: text(release?.Version, 128) || null,
    releaseId: text(release?.ReleaseId, 128) || null,
    remoteId: text(release?.RemoteId, 128) || null,
    name: text(release?.Name, 256) || null,
    summary: text(release?.Summary, 1024) || null,
    urgency: text(release?.Urgency, 64) || null,
    checksums: list(release?.Checksum ?? release?.Checksums).map(item => text(item, 256)).filter(Boolean),
    requiresReboot: list(release?.Flags).some(flag => /reboot/i.test(String(flag))) || false
  }));
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

export class FwupdLvfsService {
  #binary;
  #runner;
  #expectedOwnerUid;
  #enforceBinaryTrust;

  constructor({ binary = DEFAULT_BINARY, runner = defaultRunner, expectedOwnerUid = 0, enforceBinaryTrust = true } = {}) {
    assert(binary === DEFAULT_BINARY || enforceBinaryTrust === false, 'FWUPD_BINARY_NOT_ALLOWLISTED', 'Production fwupd integration is pinned to /usr/bin/fwupdmgr');
    assert(typeof runner === 'function', 'FWUPD_RUNNER_REQUIRED', 'fwupd runner must be a function');
    assert(expectedOwnerUid === null || (Number.isInteger(expectedOwnerUid) && expectedOwnerUid >= 0), 'INVALID_OWNER_UID', 'expectedOwnerUid must be a non-negative integer or null');
    this.#binary = binary;
    this.#runner = runner;
    this.#expectedOwnerUid = expectedOwnerUid;
    this.#enforceBinaryTrust = enforceBinaryTrust;
  }

  async probe() {
    if (!this.#enforceBinaryTrust) return Object.freeze({ available: true, binary: this.#binary, trustedBinary: true, testOverride: true });
    let stat;
    try {
      stat = await fsp.stat(this.#binary);
    } catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ available: false, binary: this.#binary, trustedBinary: false, reason: 'not-installed' });
      throw error;
    }
    const real = await fsp.realpath(this.#binary);
    assert(real === this.#binary, 'FWUPD_BINARY_SYMLINKED', 'fwupdmgr must resolve exactly to the allowlisted distro binary');
    assert(stat.isFile(), 'FWUPD_BINARY_INVALID', 'fwupdmgr must be a regular file');
    assert((stat.mode & 0o111) !== 0, 'FWUPD_BINARY_NOT_EXECUTABLE', 'fwupdmgr must be executable');
    assert((stat.mode & 0o022) === 0, 'FWUPD_BINARY_WRITABLE', 'fwupdmgr must not be writable by group or others');
    if (this.#expectedOwnerUid !== null && typeof stat.uid === 'number') {
      assert(stat.uid === this.#expectedOwnerUid, 'FWUPD_BINARY_OWNER_INVALID', 'fwupdmgr owner does not match the trusted UID');
    }
    return Object.freeze({ available: true, binary: this.#binary, trustedBinary: true, ownerUid: typeof stat.uid === 'number' ? stat.uid : null });
  }

  async #run(command) {
    assert(SAFE_COMMANDS.has(command), 'FWUPD_COMMAND_FORBIDDEN', 'Only read-only fwupd inventory commands are exposed');
    const probe = await this.probe();
    assert(probe.available, 'FWUPD_UNAVAILABLE', 'fwupdmgr is not installed on this host');
    const result = await this.#runner(this.#binary, [command, '--json'], {
      shell: false,
      timeout: 15000,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
    });
    return parseJson(String(result?.stdout ?? ''), command);
  }

  async inventory() {
    const probe = await this.probe();
    if (!probe.available) {
      return Object.freeze({
        schema: 'swir.fwupd-lvfs-inventory/0.1', available: false, readOnly: true, mutationCapable: false,
        provider: 'fwupd-lvfs', trustedRemoteId: 'lvfs', devices: [], candidates: [], ignoredNonLvfsCandidates: 0, probe
      });
    }

    const devicesDocument = await this.#run('get-devices');
    const updatesDocument = await this.#run('get-updates');
    const devices = list(devicesDocument.Devices).map(normalizeDevice);
    const allReleases = list(updatesDocument.Devices).flatMap(releasesFromDevice);
    const candidates = allReleases
      .filter(release => release.remoteId === 'lvfs')
      .map(release => ({
        ...release,
        source: { class: 'fwupd-lvfs', repositoryId: 'lvfs', ref: `fwupd:${release.deviceId || 'unknown'}:${release.releaseId || release.version || 'candidate'}` },
        trustedSource: true,
        directDownloadUrlExposed: false,
        mutationAuthorized: false
      }));

    return Object.freeze({
      schema: 'swir.fwupd-lvfs-inventory/0.1',
      available: true,
      readOnly: true,
      mutationCapable: false,
      provider: 'fwupd-lvfs',
      trustedRemoteId: 'lvfs',
      devices,
      candidates,
      ignoredNonLvfsCandidates: allReleases.length - candidates.length,
      probe
    });
  }
}

export function assertSafeFwupdLvfsInventory(inventory) {
  assert(inventory?.schema === 'swir.fwupd-lvfs-inventory/0.1', 'FWUPD_INVENTORY_SCHEMA_INVALID', 'fwupd inventory schema mismatch');
  assert(inventory.readOnly === true && inventory.mutationCapable === false, 'FWUPD_MUTATION_BOUNDARY_INVALID', 'fwupd inventory surface must remain read-only');
  for (const candidate of list(inventory.candidates)) {
    assert(candidate?.source?.class === 'fwupd-lvfs', 'FWUPD_SOURCE_CLASS_INVALID', 'Firmware candidate must use fwupd-lvfs source class');
    assert(candidate?.source?.repositoryId === 'lvfs' && candidate?.remoteId === 'lvfs', 'FWUPD_REMOTE_INVALID', 'Firmware candidate must be sourced from the LVFS remote');
    assert(candidate?.directDownloadUrlExposed === false, 'FWUPD_DIRECT_URL_FORBIDDEN', 'Driver Center must not expose arbitrary firmware download URLs');
    assert(candidate?.mutationAuthorized === false, 'FWUPD_MUTATION_PREAUTHORIZED', 'Read-only firmware discovery must never pre-authorize mutation');
  }
  return true;
}

export const FwupdLvfsPolicy = Object.freeze({
  schema: 'swir.fwupd-lvfs-policy/0.1',
  binary: DEFAULT_BINARY,
  trustedRemoteId: 'lvfs',
  exposedCommands: [...SAFE_COMMANDS],
  refreshCommandExposed: false,
  updateCommandExposed: false,
  installCommandExposed: false,
  shell: false,
  readOnly: true,
  mutationRequiresSeparatePrivilegedTransaction: true
});
