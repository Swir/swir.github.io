import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createManagedWindowsCompatibilityStack, ManagedWindowsCompatibilityPolicy } from './managed-windows-compatibility-stack.mjs';

const APP_ID = 'swir.e2e.windows.userapp';
const MAX_TIMEOUT_MS = 120_000;

function fail(code, message) {
  const error = new Error(message);
  error.name = 'WindowsCompatLiveE2EError';
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

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseArgs(argv) {
  const out = { fixture: null, prefixRoot: null, output: null, compact: false, timeoutMs: 60_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') out.fixture = argv[++index] || null;
    else if (arg === '--prefix-root') out.prefixRoot = argv[++index] || null;
    else if (arg === '--output') out.output = argv[++index] || null;
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++index]);
    else if (arg === '--compact') out.compact = true;
    else fail('UNKNOWN_ARGUMENT', `Unsupported argument: ${arg}`);
  }
  assert(out.fixture, 'FIXTURE_REQUIRED', '--fixture is required');
  assert(path.isAbsolute(out.fixture), 'FIXTURE_ABSOLUTE_REQUIRED', '--fixture must be an absolute path');
  if (out.prefixRoot) assert(path.isAbsolute(out.prefixRoot), 'PREFIX_ROOT_ABSOLUTE_REQUIRED', '--prefix-root must be an absolute path');
  assert(Number.isInteger(out.timeoutMs) && out.timeoutMs >= 1_000 && out.timeoutMs <= MAX_TIMEOUT_MS, 'TIMEOUT_INVALID', `--timeout-ms must be between 1000 and ${MAX_TIMEOUT_MS}`);
  return out;
}

function validateFixture(fixture) {
  const lst = fs.lstatSync(fixture);
  assert(!lst.isSymbolicLink(), 'FIXTURE_SYMLINK_FORBIDDEN', 'Windows E2E fixture must not be a symlink');
  assert(lst.isFile(), 'FIXTURE_NOT_FILE', 'Windows E2E fixture must be a regular file');
  assert(path.extname(fixture).toLowerCase() === '.exe', 'FIXTURE_EXTENSION_INVALID', 'Windows E2E fixture must be a .exe user application');
  const header = Buffer.alloc(2);
  const fd = fs.openSync(fixture, 'r');
  try { fs.readSync(fd, header, 0, 2, 0); }
  finally { fs.closeSync(fd); }
  assert(header.toString('ascii') === 'MZ', 'FIXTURE_NOT_PE', 'Windows E2E fixture does not have an MZ/PE header');
  return fs.realpathSync(fixture);
}

function createPrefixRoot(requested) {
  if (requested) {
    fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
    const lst = fs.lstatSync(requested);
    assert(!lst.isSymbolicLink() && lst.isDirectory(), 'PREFIX_ROOT_INVALID', 'Compatibility prefix root must be a real directory');
    fs.chmodSync(requested, 0o700);
    return fs.realpathSync(requested);
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swir-windows-compat-live-'));
}

async function waitForExit(stack, appId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = stack.get(appId);
    if (record && record.state !== 'running') return record;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  stack.stop(appId, { signal: 'SIGKILL' });
  fail('WINDOWS_APP_TIMEOUT', `Windows compatibility application exceeded ${timeoutMs} ms`);
}

export async function runWindowsCompatibilityLiveE2E({ fixture, prefixRoot = null, timeoutMs = 60_000 } = {}) {
  assert(process.platform === 'linux', 'LINUX_REQUIRED', 'Windows compatibility live E2E requires Linux');
  const source = validateFixture(fixture);
  const root = createPrefixRoot(prefixRoot);
  const stack = createManagedWindowsCompatibilityStack({ prefixRoot: root, probeTimeoutMs: 5_000 });
  const description = stack.describe();
  assert(description.providers.wine === true, 'WINE_RUNTIME_UNAVAILABLE', 'No trusted healthy Wine runtime was discovered');
  assert(description.arbitraryRuntimeDownloadAllowed === false, 'RUNTIME_DOWNLOAD_POLICY_WEAK', 'Arbitrary compatibility runtime downloads must remain disabled');
  assert(description.prefixPolicy === 'per-app', 'PREFIX_POLICY_INVALID', 'Compatibility prefixes must remain per-app');

  const entryPoint = path.join(root, APP_ID, 'drive_c', 'swir-e2e', 'swir-e2e.exe');
  const manifest = {
    schema: 'swir.package-provider/0.2',
    id: APP_ID,
    targetEditions: ['system'],
    executionClass: 'windows-compat',
    provider: 'swir.compat.wine',
    package: { nativeEntryPoint: entryPoint },
    compatibility: { prefixPolicy: 'per-app', windowsArchitecture: 'win64' },
    trust: { signatureRequired: true }
  };

  const prepared = stack.prepare(manifest, { trustVerified: true });
  assert(within(prepared.prefix, root), 'PREFIX_ESCAPED_ROOT', 'Managed Wine prefix escaped the requested prefix root');
  const targetDirectory = path.dirname(entryPoint);
  fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, entryPoint, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(entryPoint, 0o700);
  const target = fs.realpathSync(entryPoint);
  assert(within(target, prepared.prefix), 'WINDOWS_ENTRYPOINT_ESCAPED_PREFIX', 'Windows user application escaped its managed prefix');

  const plan = stack.plan(manifest, { trustVerified: true, environment: process.env });
  assert(plan.shell === false, 'SHELL_EXECUTION_FORBIDDEN', 'Wine launch plan must not use a shell');
  assert(plan.brokerRequired === true, 'BROKER_REQUIRED', 'Wine launch plan must retain the broker boundary');
  assert(plan.trust?.verified === true && plan.trust?.signatureRequired === true, 'PACKAGE_TRUST_NOT_BOUND', 'Wine launch plan is not bound to verified package trust');
  assert(plan.runtime?.family === 'wine', 'RUNTIME_FAMILY_INVALID', 'Expected Wine runtime family');
  assert(plan.environment?.WINEPREFIX === prepared.prefix && plan.environment?.WINEARCH === 'win64', 'WINE_ENVIRONMENT_INVALID', 'Wine environment is not bound to the managed per-app prefix');

  const started = stack.launch(manifest, { trustVerified: true, environment: process.env, stdio: 'ignore' });
  assert(Number.isInteger(started.pid) && started.pid > 1, 'WINDOWS_APP_PID_INVALID', 'Wine user application did not start with a valid PID');
  const exited = await waitForExit(stack, APP_ID, timeoutMs);
  assert(exited.state === 'exited' && exited.exitCode === 0 && exited.signal === null, 'WINDOWS_APP_EXECUTION_FAILED', `Wine user application failed: state=${exited.state} exit=${exited.exitCode} signal=${exited.signal || 'none'}`);

  const inventory = stack.inventory();
  const wine = inventory.runtimes.find(runtime => runtime.provider === 'swir.compat.wine' && runtime.healthy === true);
  assert(wine, 'WINE_RUNTIME_DISAPPEARED', 'Trusted Wine runtime disappeared after execution');
  assert(wine.trust?.rootOwned === true && wine.trust?.writableByGroupOrWorld === false && wine.trust?.executable === true, 'WINE_RUNTIME_TRUST_INVALID', 'Wine runtime trust properties are invalid');

  return {
    schema: 'swir.windows-compat-live-e2e/0.1',
    generatedAt: new Date().toISOString(),
    provider: 'swir.compat.wine',
    runtimeFamily: 'wine',
    runtimeVersion: wine.version,
    runtimeExecutable: wine.executable,
    runtimeRootOwned: wine.trust.rootOwned,
    runtimeGroupWorldWritable: wine.trust.writableByGroupOrWorld,
    runtimeHealthy: wine.healthy,
    appId: APP_ID,
    fixtureSha256: sha256(source),
    executionClass: 'windows-compat',
    perAppPrefix: true,
    prefixInsideManagedRoot: within(prepared.prefix, root),
    trustVerified: plan.trust.verified,
    signatureRequired: plan.trust.signatureRequired,
    brokerRequired: plan.brokerRequired,
    shellExecution: plan.shell,
    processStarted: true,
    processExitCode: exited.exitCode,
    processSignal: exited.signal,
    arbitraryRuntimeDownloadAllowed: ManagedWindowsCompatibilityPolicy.arbitraryRuntimeDownloadAllowed,
    windowsKernelDriverSupport: ManagedWindowsCompatibilityPolicy.directWindowsKernelDriverSupport,
    hardwareQualificationClaim: false,
    passed: true
  };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const evidence = await runWindowsCompatibilityLiveE2E(args);
    const json = JSON.stringify(evidence, null, args.compact ? 0 : 2) + '\n';
    if (args.output) fs.writeFileSync(args.output, json, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(json);
  } catch (error) {
    process.stderr.write(`${error?.code || error?.name || 'ERROR'}: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
