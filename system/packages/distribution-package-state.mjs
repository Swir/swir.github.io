import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9+._:@-]{0,127}$/;
const MANAGERS = new Set(['apt', 'dnf', 'rpm-ostree', 'pacman', 'zypper']);
const SAFE_ENVIRONMENT = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });

function assert(condition, code, message) {
  if (condition) return;
  const error = new Error(message);
  error.name = 'DistributionPackageStateError';
  error.code = code;
  throw error;
}

function queryFor(manager, packageName) {
  assert(MANAGERS.has(manager), 'UNSUPPORTED_PACKAGE_MANAGER', 'unsupported package manager for state snapshot');
  assert(PACKAGE_NAME.test(packageName), 'INVALID_PACKAGE_NAME', 'invalid package name for state snapshot');
  if (manager === 'apt') {
    return { source: 'dpkg-query', file: '/usr/bin/dpkg-query', args: ['-W', '-f=${Status}\t${Version}\n', packageName] };
  }
  if (manager === 'pacman') {
    return { source: 'pacman', file: '/usr/bin/pacman', args: ['-Q', packageName] };
  }
  return { source: 'rpm', file: '/usr/bin/rpm', args: ['-q', '--qf', '%{VERSION}-%{RELEASE}\n', packageName] };
}

function parseVersion(manager, packageName, result) {
  if (result.exitCode !== 0) return { installed: false, version: null };
  const output = String(result.stdout || '').trim();
  if (manager === 'apt') {
    const [status, version] = output.split('\t');
    return status === 'install ok installed' && version
      ? { installed: true, version }
      : { installed: false, version: null };
  }
  if (manager === 'pacman') {
    const prefix = `${packageName} `;
    return output.startsWith(prefix) && output.length > prefix.length
      ? { installed: true, version: output.slice(prefix.length).trim() }
      : { installed: false, version: null };
  }
  return output ? { installed: true, version: output.split(/\r?\n/, 1)[0] } : { installed: false, version: null };
}

function defaultRunner(file, args, { timeoutMs = 5000, maxOutputBytes = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...SAFE_ENVIRONMENT }
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const collect = (kind, chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      bytes += Buffer.byteLength(text);
      if (bytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(reject, Object.assign(new Error('package state query output limit exceeded'), { code: 'STATE_QUERY_OUTPUT_LIMIT' }));
        return;
      }
      if (kind === 'stdout') stdout += text;
      else stderr += text;
    };
    child.stdout?.on('data', chunk => collect('stdout', chunk));
    child.stderr?.on('data', chunk => collect('stderr', chunk));
    child.on('error', error => finish(reject, error));
    child.on('close', (exitCode, signal) => finish(resolve, { exitCode, signal: signal || null, stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, Object.assign(new Error('package state query timed out'), { code: 'STATE_QUERY_TIMEOUT' }));
    }, timeoutMs);
    timer.unref?.();
  });
}

export class DistributionPackageSnapshotProvider {
  #runner;
  #clock;

  constructor({ runner = defaultRunner, clock = () => new Date().toISOString() } = {}) {
    assert(typeof runner === 'function', 'INVALID_RUNNER', 'package state runner must be a function');
    this.#runner = runner;
    this.#clock = clock;
  }

  async capture({ manager, packageName, packageId = null } = {}) {
    const query = queryFor(manager, packageName);
    const result = await this.#runner(query.file, [...query.args], { timeoutMs: 5000, maxOutputBytes: 64 * 1024 });
    assert(result && Number.isInteger(result.exitCode), 'INVALID_QUERY_RESULT', 'package state runner returned invalid result');
    const state = parseVersion(manager, packageName, result);
    return {
      schema: 'swir.package-snapshot/0.1',
      capturedAt: this.#clock(),
      packageId,
      manager,
      packageName,
      installed: state.installed,
      version: state.version,
      query: {
        source: query.source,
        exitCode: result.exitCode,
        signal: result.signal || null
      }
    };
  }
}

function isInsideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class NativePackageHealthVerifier {
  #allowedRoots;
  #lstatSync;
  #realpathSync;
  #accessSync;

  constructor({
    allowedRoots = ['/usr', '/opt'],
    lstatSync = fs.lstatSync,
    realpathSync = fs.realpathSync,
    accessSync = fs.accessSync
  } = {}) {
    this.#allowedRoots = [...new Set(allowedRoots.map(root => path.resolve(root)))];
    assert(this.#allowedRoots.length > 0, 'HEALTH_ROOT_REQUIRED', 'at least one native package health root is required');
    this.#lstatSync = lstatSync;
    this.#realpathSync = realpathSync;
    this.#accessSync = accessSync;
  }

  async verify({ packageId = null, packageName, nativeEntryPoint, operation } = {}) {
    if (operation === 'remove') {
      return { schema: 'swir.package-health/0.1', packageId, packageName, healthy: true, checks: [{ id: 'removed', ok: true }] };
    }
    if (typeof nativeEntryPoint !== 'string' || !path.isAbsolute(nativeEntryPoint)) {
      return { schema: 'swir.package-health/0.1', packageId, packageName, healthy: false, checks: [{ id: 'native-entry-point', ok: false, reason: 'ENTRY_POINT_ABSOLUTE_PATH_REQUIRED' }] };
    }

    try {
      const linkStat = this.#lstatSync(nativeEntryPoint);
      const resolved = path.resolve(this.#realpathSync(nativeEntryPoint));
      const insideAllowedRoot = this.#allowedRoots.some(root => isInsideRoot(resolved, root));
      if (!insideAllowedRoot) {
        return { schema: 'swir.package-health/0.1', packageId, packageName, healthy: false, checks: [{ id: 'native-entry-point-root', ok: false, reason: 'ENTRY_POINT_OUTSIDE_ALLOWED_ROOT' }] };
      }
      const targetStat = linkStat.isSymbolicLink?.() ? this.#lstatSync(resolved) : linkStat;
      if (targetStat?.isFile?.() !== true) {
        return { schema: 'swir.package-health/0.1', packageId, packageName, healthy: false, checks: [{ id: 'native-entry-point-file', ok: false, reason: 'ENTRY_POINT_NOT_FILE' }] };
      }
      try {
        this.#accessSync(resolved, fs.constants.X_OK);
      } catch {
        return { schema: 'swir.package-health/0.1', packageId, packageName, healthy: false, checks: [{ id: 'native-entry-point-executable', ok: false, reason: 'ENTRY_POINT_NOT_EXECUTABLE' }] };
      }
      return {
        schema: 'swir.package-health/0.1',
        packageId,
        packageName,
        healthy: true,
        checks: [
          { id: 'native-entry-point-root', ok: true, resolved },
          { id: 'native-entry-point-file', ok: true },
          { id: 'native-entry-point-executable', ok: true }
        ]
      };
    } catch (error) {
      return {
        schema: 'swir.package-health/0.1',
        packageId,
        packageName,
        healthy: false,
        checks: [{ id: 'native-entry-point', ok: false, reason: error?.code === 'ENOENT' ? 'ENTRY_POINT_NOT_FOUND' : 'ENTRY_POINT_PROBE_FAILED' }]
      };
    }
  }
}

export const DistributionPackageStatePolicy = Object.freeze({
  schema: 'swir.package-snapshot/0.1',
  readOnly: true,
  shellExecution: false,
  inheritedEnvironment: false,
  supportedManagers: [...MANAGERS],
  defaultHealthRoots: ['/usr', '/opt']
});
