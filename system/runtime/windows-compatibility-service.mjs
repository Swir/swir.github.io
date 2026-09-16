import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const COMPAT_PROVIDERS = new Map([
  ['swir.compat.wine', 'wine'],
  ['swir.compat.proton', 'proton']
]);

const DEFAULT_PREFIX_ROOT = '/var/lib/swir/compat/prefixes';
const DEFAULT_RUNTIME_ROOTS = ['/usr/bin', '/usr/local/bin', '/opt/swir/runtimes', '/usr/lib/swir/runtimes'];
const SAFE_HOST_ENV = new Set([
  'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TERM', 'USER', 'LOGNAME',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP',
  'DBUS_SESSION_BUS_ADDRESS', 'PULSE_SERVER'
]);
const SAFE_SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGKILL']);
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.exe', '.com']);
const METADATA_FILE = '.swir-compat.json';

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function within(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function validateAppId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,127}$/i.test(value)) throw new Error('invalid appId');
  return value;
}

function validateArgs(args = []) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('args must be NUL-free strings');
  }
  if (args.length > 256) throw new Error('too many compatibility arguments');
  return [...args];
}

function safeRealpath(target, label) {
  let resolved;
  try { resolved = fs.realpathSync(target); }
  catch { throw new Error(`${label} does not exist`); }
  return resolved;
}

function requireRegularFile(target, label, { executable = false } = {}) {
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (executable && (stat.mode & 0o111) === 0) throw new Error(`${label} is not executable`);
}

function resolveAllowedPath(target, roots, label, { executable = false } = {}) {
  if (!path.isAbsolute(target || '')) throw new Error(`${label} must be an absolute path`);
  const resolved = safeRealpath(target, label);
  const normalizedRoots = roots.map(root => path.resolve(root));
  if (!normalizedRoots.some(root => within(resolved, root))) throw new Error(`${label} is outside approved roots`);
  requireRegularFile(resolved, label, { executable });
  return resolved;
}

function providerFamily(provider) {
  const family = COMPAT_PROVIDERS.get(provider);
  if (!family) throw new Error('unsupported Windows compatibility provider');
  return family;
}

export function validateCompatibilityManifest(manifest, options = {}) {
  assertObject(manifest, 'package manifest');
  if (manifest.schema !== 'swir.package-provider/0.2') throw new Error('unsupported package provider schema');
  validateAppId(manifest.id);
  if (!Array.isArray(manifest.targetEditions) || !manifest.targetEditions.includes('system')) throw new Error('package does not target System Edition');
  if (manifest.executionClass !== 'windows-compat') throw new Error('compatibility service accepts windows-compat only');
  const family = providerFamily(manifest.provider);
  assertObject(manifest.package, 'package');
  if (typeof manifest.package.nativeEntryPoint !== 'string' || !manifest.package.nativeEntryPoint) throw new Error('nativeEntryPoint is required');
  if (!path.isAbsolute(manifest.package.nativeEntryPoint)) throw new Error('Windows entry point must be an absolute managed-prefix path');
  assertObject(manifest.compatibility, 'compatibility');
  if (manifest.compatibility.prefixPolicy !== 'per-app') throw new Error('only per-app compatibility prefixes are supported by the guarded prototype');
  if (!['win64', 'win32'].includes(manifest.compatibility.windowsArchitecture)) throw new Error('unsupported Windows architecture');
  assertObject(manifest.trust, 'trust');
  if (manifest.trust.signatureRequired !== true) throw new Error('Windows compatibility package must require signature verification');
  if (options.trustVerified !== true) throw new Error('package trust must be verified before compatibility launch');
  return { family };
}

export function sanitizeCompatibilityEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => SAFE_HOST_ENV.has(key) && typeof value === 'string'));
}

export function managedPrefixPath(appId, { prefixRoot = DEFAULT_PREFIX_ROOT } = {}) {
  validateAppId(appId);
  const root = path.resolve(prefixRoot);
  const candidate = path.resolve(root, appId);
  if (!within(candidate, root)) throw new Error('managed prefix escaped prefix root');
  return candidate;
}

function metadataFor(manifest) {
  return {
    schema: 'swir.compat-prefix/0.1',
    appId: manifest.id,
    provider: manifest.provider,
    architecture: manifest.compatibility.windowsArchitecture,
    prefixPolicy: 'per-app'
  };
}

function readPrefixMetadata(prefix) {
  const file = path.join(prefix, METADATA_FILE);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function assertMetadataMatches(actual, expected) {
  if (!actual || actual.schema !== expected.schema || actual.appId !== expected.appId || actual.provider !== expected.provider || actual.architecture !== expected.architecture || actual.prefixPolicy !== 'per-app') {
    throw new Error('managed compatibility prefix metadata mismatch');
  }
}

export function prepareManagedPrefix(manifest, options = {}) {
  validateCompatibilityManifest(manifest, options);
  const root = path.resolve(options.prefixRoot || DEFAULT_PREFIX_ROOT);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync(root);
  const prefix = managedPrefixPath(manifest.id, { prefixRoot: realRoot });
  if (fs.existsSync(prefix) && fs.lstatSync(prefix).isSymbolicLink()) throw new Error('managed compatibility prefix must not be a symbolic link');
  fs.mkdirSync(prefix, { recursive: true, mode: 0o700 });
  const realPrefix = fs.realpathSync(prefix);
  if (!within(realPrefix, realRoot)) throw new Error('managed compatibility prefix escaped prefix root');

  const expected = metadataFor(manifest);
  const metadataFile = path.join(realPrefix, METADATA_FILE);
  if (fs.existsSync(metadataFile)) {
    assertMetadataMatches(readPrefixMetadata(realPrefix), expected);
  } else {
    fs.writeFileSync(metadataFile, `${JSON.stringify(expected, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  return { prefix: realPrefix, metadata: expected };
}

function resolveRuntime(manifest, options = {}) {
  const configured = options.runtimePaths?.[manifest.provider];
  if (!configured) throw new Error(`no approved runtime configured for ${manifest.provider}`);
  const roots = options.runtimeRoots || DEFAULT_RUNTIME_ROOTS;
  return resolveAllowedPath(configured, roots, 'compatibility runtime', { executable: true });
}

function resolveWindowsEntryPoint(manifest, prefix) {
  const resolved = safeRealpath(manifest.package.nativeEntryPoint, 'Windows entry point');
  if (!within(resolved, prefix)) throw new Error('Windows entry point is outside its managed prefix');
  requireRegularFile(resolved, 'Windows entry point');
  const ext = path.extname(resolved).toLowerCase();
  if (!WINDOWS_EXECUTABLE_EXTENSIONS.has(ext)) throw new Error('FORBIDDEN_WINDOWS_ARTIFACT: compatibility launcher accepts .exe/.com user applications only');
  return resolved;
}

function runtimeArgs(family, executable, args) {
  if (family === 'wine') return [executable, ...args];
  if (family === 'proton') return ['run', executable, ...args];
  throw new Error('unsupported compatibility runtime family');
}

export function buildCompatibilityLaunchPlan(manifest, options = {}) {
  const { family } = validateCompatibilityManifest(manifest, options);
  const prefixRoot = path.resolve(options.prefixRoot || DEFAULT_PREFIX_ROOT);
  const prefix = safeRealpath(managedPrefixPath(manifest.id, { prefixRoot }), 'managed compatibility prefix');
  const realPrefixRoot = safeRealpath(prefixRoot, 'compatibility prefix root');
  if (!within(prefix, realPrefixRoot)) throw new Error('managed compatibility prefix escaped prefix root');
  assertMetadataMatches(readPrefixMetadata(prefix), metadataFor(manifest));

  const runtimeExecutable = resolveRuntime(manifest, options);
  const windowsExecutable = resolveWindowsEntryPoint(manifest, prefix);
  const args = validateArgs(options.args || []);
  const environment = sanitizeCompatibilityEnvironment(options.environment || process.env);
  environment.WINEPREFIX = prefix;
  environment.WINEARCH = manifest.compatibility.windowsArchitecture;
  if (family === 'proton') environment.STEAM_COMPAT_DATA_PATH = prefix;

  return {
    schema: 'swir.windows-compat-launch/0.1',
    mode: 'guarded',
    brokerRequired: true,
    shell: false,
    executionClass: 'windows-compat',
    appId: manifest.id,
    provider: manifest.provider,
    architecture: manifest.compatibility.windowsArchitecture,
    prefixPolicy: 'per-app',
    prefix,
    application: {
      executable: windowsExecutable,
      args
    },
    runtime: {
      family,
      executable: runtimeExecutable,
      args: runtimeArgs(family, windowsExecutable, args)
    },
    environment,
    trust: {
      verified: true,
      signatureRequired: true
    }
  };
}

function snapshot(record) {
  if (!record) return null;
  return {
    appId: record.appId,
    provider: record.provider,
    prefix: record.prefix,
    pid: record.pid,
    state: record.state,
    startedAt: record.startedAt,
    exitCode: record.exitCode,
    signal: record.signal
  };
}

export class WindowsCompatibilityService extends EventEmitter {
  #spawn;
  #records = new Map();
  #defaults;

  constructor({ spawnImpl = spawn, prefixRoot = DEFAULT_PREFIX_ROOT, runtimePaths = {}, runtimeRoots = DEFAULT_RUNTIME_ROOTS } = {}) {
    super();
    this.#spawn = spawnImpl;
    this.#defaults = { prefixRoot, runtimePaths: { ...runtimePaths }, runtimeRoots: [...runtimeRoots] };
  }

  prepare(manifest, options = {}) {
    return prepareManagedPrefix(manifest, { ...this.#defaults, ...options, runtimePaths: options.runtimePaths || this.#defaults.runtimePaths });
  }

  plan(manifest, options = {}) {
    return buildCompatibilityLaunchPlan(manifest, { ...this.#defaults, ...options, runtimePaths: options.runtimePaths || this.#defaults.runtimePaths });
  }

  launch(manifest, options = {}) {
    const existing = this.#records.get(manifest?.id);
    if (existing?.state === 'running') throw new Error('compatibility application is already running');
    const plan = this.plan(manifest, options);
    const child = this.#spawn(plan.runtime.executable, plan.runtime.args, {
      cwd: path.dirname(plan.application.executable),
      env: plan.environment,
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: options.stdio || 'ignore'
    });
    const record = {
      appId: plan.appId,
      provider: plan.provider,
      prefix: plan.prefix,
      pid: child.pid ?? null,
      child,
      state: 'running',
      startedAt: new Date().toISOString(),
      exitCode: null,
      signal: null
    };
    this.#records.set(record.appId, record);
    child.once('error', error => {
      record.state = 'failed';
      record.error = error?.message || String(error);
      this.emit('errorState', { ...snapshot(record), error: record.error });
    });
    child.once('exit', (code, signal) => {
      record.state = code === 0 ? 'exited' : 'failed';
      record.exitCode = code;
      record.signal = signal;
      this.emit('exited', snapshot(record));
    });
    const started = snapshot(record);
    this.emit('started', started);
    return started;
  }

  list() {
    return [...this.#records.values()].map(snapshot).sort((a, b) => a.appId.localeCompare(b.appId));
  }

  get(appId) {
    return snapshot(this.#records.get(appId));
  }

  stop(appId, { signal = 'SIGTERM' } = {}) {
    if (!SAFE_SIGNALS.has(signal)) throw new Error('unsupported stop signal');
    const record = this.#records.get(appId);
    if (!record || record.state !== 'running') return false;
    return record.child.kill(signal);
  }

  forget(appId) {
    const record = this.#records.get(appId);
    if (!record) return false;
    if (record.state === 'running') throw new Error('cannot forget a running compatibility application');
    return this.#records.delete(appId);
  }
}

export const WindowsCompatibilityPolicy = Object.freeze({
  schema: 'swir.windows-compat-launch/0.1',
  acceptedManifest: 'swir.package-provider/0.2',
  targetEdition: 'system',
  executionClass: 'windows-compat',
  providers: [...COMPAT_PROVIDERS.keys()],
  prefixPolicy: 'per-app',
  prefixRoot: DEFAULT_PREFIX_ROOT,
  runtimeRoots: [...DEFAULT_RUNTIME_ROOTS],
  environmentAllowlist: [...SAFE_HOST_ENV],
  windowsExecutableExtensions: [...WINDOWS_EXECUTABLE_EXTENSIONS],
  trustVerifiedRequired: true,
  signatureRequired: true,
  brokerRequired: true,
  shellExecution: false
});
