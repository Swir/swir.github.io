import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PROVIDERS = Object.freeze({
  'swir.compat.wine': Object.freeze({ family: 'wine', executableNames: ['wine64', 'wine'] }),
  'swir.compat.proton': Object.freeze({ family: 'proton', executableNames: ['proton'] })
});
const DEFAULT_RUNTIME_ROOTS = Object.freeze(['/usr/bin', '/usr/local/bin', '/opt/swir/runtimes', '/usr/lib/swir/runtimes']);
const VERSION_ARGS = Object.freeze({ wine: ['--version'], proton: ['--version'] });
const MAX_SCAN_DEPTH = 3;
const MAX_SCAN_ENTRIES = 8192;

function fail(code, message) {
  const error = new Error(message);
  error.name = 'WindowsCompatibilityRuntimeRegistryError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function within(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeRoots(roots) {
  assert(Array.isArray(roots) && roots.length > 0, 'INVALID_RUNTIME_ROOTS', 'At least one approved runtime root is required');
  const normalized = [...new Set(roots.map(root => {
    assert(typeof root === 'string' && path.isAbsolute(root), 'INVALID_RUNTIME_ROOT', 'Compatibility runtime roots must be absolute');
    return path.resolve(root);
  }))];
  return normalized.sort();
}

function candidateProvider(fileName) {
  for (const [provider, metadata] of Object.entries(PROVIDERS)) {
    if (metadata.executableNames.includes(fileName)) return provider;
  }
  return null;
}

function scanRoot(root, { maxDepth = MAX_SCAN_DEPTH, maxEntries = MAX_SCAN_ENTRIES } = {}) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const queue = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) fail('RUNTIME_SCAN_LIMIT', `Compatibility runtime scan exceeded ${maxEntries} entries under ${root}`);
      const fullPath = path.join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ directory: fullPath, depth: current.depth + 1 });
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        const provider = candidateProvider(entry.name);
        if (provider) found.push({ provider, candidate: fullPath });
      }
    }
  }
  return found;
}

function inspectCandidate(provider, candidate, roots, { requireRootOwned }) {
  const metadata = PROVIDERS[provider];
  assert(metadata, 'UNSUPPORTED_PROVIDER', 'Unsupported compatibility runtime provider');
  let resolved;
  try { resolved = fs.realpathSync(candidate); }
  catch { fail('RUNTIME_NOT_FOUND', 'Compatibility runtime candidate does not resolve'); }
  assert(roots.some(root => within(resolved, root)), 'RUNTIME_OUTSIDE_APPROVED_ROOTS', 'Compatibility runtime resolves outside approved roots');
  const stat = fs.statSync(resolved);
  assert(stat.isFile(), 'RUNTIME_NOT_REGULAR_FILE', 'Compatibility runtime must be a regular file');
  assert((stat.mode & 0o111) !== 0, 'RUNTIME_NOT_EXECUTABLE', 'Compatibility runtime is not executable');
  assert((stat.mode & 0o022) === 0, 'RUNTIME_WRITABLE_BY_UNTRUSTED', 'Compatibility runtime must not be group/world writable');
  if (requireRootOwned) assert(stat.uid === 0, 'RUNTIME_NOT_ROOT_OWNED', 'Compatibility runtime must be owned by root');
  return { provider, family: metadata.family, candidate: path.resolve(candidate), executable: resolved, uid: stat.uid, mode: stat.mode & 0o7777 };
}

function probeVersion(runtime, { timeoutMs }) {
  const result = spawnSync(runtime.executable, VERSION_ARGS[runtime.family], {
    shell: false,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim().split(/\r?\n/).find(Boolean) || '';
  return {
    healthy: result.error == null && result.status === 0,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal || null,
    version: output.slice(0, 256) || null,
    error: result.error ? String(result.error.message || result.error).slice(0, 256) : null
  };
}

function runtimeId(runtime, probe) {
  return `compat:${runtime.family}:${crypto.createHash('sha256').update(`${runtime.provider}\0${runtime.executable}\0${probe.version || ''}`).digest('hex').slice(0, 16)}`;
}

function snapshotRuntime(runtime, probe) {
  return Object.freeze({
    id: runtimeId(runtime, probe),
    provider: runtime.provider,
    family: runtime.family,
    executable: runtime.executable,
    version: probe.version,
    healthy: probe.healthy,
    exitCode: probe.exitCode,
    signal: probe.signal,
    error: probe.error,
    trust: Object.freeze({
      rootOwned: runtime.uid === 0,
      writableByGroupOrWorld: (runtime.mode & 0o022) !== 0,
      executable: (runtime.mode & 0o111) !== 0
    })
  });
}

export class WindowsCompatibilityRuntimeRegistry {
  #roots;
  #requireRootOwned;
  #timeoutMs;
  #inventory = null;

  constructor({ runtimeRoots = DEFAULT_RUNTIME_ROOTS, requireRootOwned = true, probeTimeoutMs = 3000 } = {}) {
    this.#roots = normalizeRoots(runtimeRoots);
    assert(Number.isInteger(probeTimeoutMs) && probeTimeoutMs >= 250 && probeTimeoutMs <= 15000, 'INVALID_PROBE_TIMEOUT', 'Compatibility runtime probe timeout is out of bounds');
    this.#requireRootOwned = requireRootOwned === true;
    this.#timeoutMs = probeTimeoutMs;
  }

  discover() {
    const candidates = this.#roots.flatMap(root => scanRoot(root));
    const deduped = new Map();
    const rejected = [];
    for (const item of candidates) {
      try {
        const inspected = inspectCandidate(item.provider, item.candidate, this.#roots, { requireRootOwned: this.#requireRootOwned });
        const key = `${item.provider}\0${inspected.executable}`;
        if (!deduped.has(key)) deduped.set(key, inspected);
      } catch (error) {
        rejected.push({ provider: item.provider, candidate: item.candidate, code: error?.code || 'RUNTIME_REJECTED' });
      }
    }

    const runtimes = [...deduped.values()].map(runtime => snapshotRuntime(runtime, probeVersion(runtime, { timeoutMs: this.#timeoutMs })))
      .sort((a, b) => a.provider.localeCompare(b.provider) || String(b.version || '').localeCompare(String(a.version || '')) || a.executable.localeCompare(b.executable));

    this.#inventory = Object.freeze({
      schema: 'swir.compat-runtime-inventory/0.1',
      mode: 'read-only-discovery',
      runtimeRoots: Object.freeze([...this.#roots]),
      rootOwnershipRequired: this.#requireRootOwned,
      runtimes: Object.freeze(runtimes),
      rejected: Object.freeze(rejected.sort((a, b) => a.candidate.localeCompare(b.candidate))),
      arbitraryDownloadAllowed: false,
      shellExecution: false
    });
    return this.#inventory;
  }

  inventory() {
    return this.#inventory || this.discover();
  }

  select(provider, { runtimeId: preferredRuntimeId = null } = {}) {
    assert(PROVIDERS[provider], 'UNSUPPORTED_PROVIDER', 'Unsupported compatibility runtime provider');
    const available = this.inventory().runtimes.filter(runtime => runtime.provider === provider && runtime.healthy);
    assert(available.length > 0, 'RUNTIME_UNAVAILABLE', `No trusted healthy runtime is available for ${provider}`);
    if (preferredRuntimeId) {
      const selected = available.find(runtime => runtime.id === preferredRuntimeId);
      assert(selected, 'RUNTIME_ID_UNAVAILABLE', 'Requested compatibility runtime is unavailable or unhealthy');
      return selected;
    }
    return available[0];
  }

  serviceOptions() {
    const runtimePaths = {};
    for (const provider of Object.keys(PROVIDERS)) {
      try { runtimePaths[provider] = this.select(provider).executable; }
      catch (error) {
        if (error?.code !== 'RUNTIME_UNAVAILABLE') throw error;
      }
    }
    return Object.freeze({ runtimePaths: Object.freeze(runtimePaths), runtimeRoots: Object.freeze([...this.#roots]) });
  }
}

export const WindowsCompatibilityRuntimeRegistryPolicy = Object.freeze({
  schema: 'swir.compat-runtime-inventory/0.1',
  providers: Object.keys(PROVIDERS),
  defaultRuntimeRoots: [...DEFAULT_RUNTIME_ROOTS],
  rootOwnershipRequiredByDefault: true,
  groupWorldWritableRejected: true,
  realpathBoundaryRequired: true,
  versionProbeShell: false,
  arbitraryDownloads: false,
  maxScanDepth: MAX_SCAN_DEPTH,
  maxScanEntries: MAX_SCAN_ENTRIES
});
