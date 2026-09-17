import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  ManagedWindowsCompatibilityPolicy,
  createManagedWindowsCompatibilityStack
} from './managed-windows-compatibility-stack.mjs';

const APP_ID = 'swir.e2e.windows.wine';
const PROVIDER = 'swir.compat.wine';
const MARKER_NAME = 'swir-wine-e2e.marker';
const EXPECTED_MARKER = 'SWIR_WINE_E2E_OK';

function fail(code, message) {
  const error = new Error(message);
  error.name = 'WindowsCompatibilityLiveE2EError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseArgs(argv) {
  const out = { executable: null, workRoot: null, output: null, compact: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--executable') out.executable = argv[++index] || null;
    else if (arg === '--work-root') out.workRoot = argv[++index] || null;
    else if (arg === '--output') out.output = argv[++index] || null;
    else if (arg === '--compact') out.compact = true;
    else fail('UNKNOWN_ARGUMENT', `Unsupported argument: ${arg}`);
  }
  assert(out.executable && path.isAbsolute(out.executable), 'EXECUTABLE_REQUIRED', '--executable must be an absolute path');
  assert(out.workRoot && path.isAbsolute(out.workRoot), 'WORK_ROOT_REQUIRED', '--work-root must be an absolute path');
  if (out.output) assert(path.isAbsolute(out.output), 'OUTPUT_PATH_INVALID', '--output must be an absolute path');
  return out;
}

function safeDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'WORK_ROOT_UNSAFE', 'work root must be a real directory');
  return fs.realpathSync(directory);
}

function safeFixture(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'FIXTURE_INVALID', 'Windows fixture must be a regular non-symlink file');
  const resolved = fs.realpathSync(file);
  assert(path.extname(resolved).toLowerCase() === '.exe', 'FIXTURE_EXTENSION_INVALID', 'Windows fixture must use .exe');
  assert(stat.size > 0 && stat.size <= 8 * 1024 * 1024, 'FIXTURE_SIZE_INVALID', 'Windows fixture has an invalid size');
  return resolved;
}

async function waitForTerminal(stack, appId, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = stack.get(appId);
    if (current && current.state !== 'running') return current;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  stack.stop(appId, { signal: 'SIGKILL' });
  fail('WINDOWS_PROCESS_TIMEOUT', 'Wine compatibility application did not reach a terminal state');
}

export async function runWindowsCompatibilityLiveE2E({ executable, workRoot } = {}) {
  assert(process.platform === 'linux', 'LINUX_REQUIRED', 'Windows compatibility live E2E requires Linux');
  const fixture = safeFixture(executable);
  const root = safeDirectory(workRoot);
  const prefixRoot = safeDirectory(path.join(root, 'prefixes'));
  const home = safeDirectory(path.join(root, 'home'));

  const stack = createManagedWindowsCompatibilityStack({
    prefixRoot,
    runtimeRoots: ['/usr/bin', '/usr/lib/wine', '/usr/lib64/wine'],
    probeTimeoutMs: 5000
  });
  const description = stack.describe();
  const inventory = stack.inventory();
  const runtime = inventory.runtimes.find(item => item.provider === PROVIDER && item.healthy === true);
  assert(runtime, 'WINE_RUNTIME_UNAVAILABLE', 'No trusted healthy Wine runtime was discovered');
  assert(runtime.trust?.rootOwned === true, 'WINE_RUNTIME_NOT_ROOT_OWNED', 'Wine runtime must be root-owned');
  assert(runtime.trust?.writableByGroupOrWorld === false, 'WINE_RUNTIME_WRITABLE', 'Wine runtime must not be group/world writable');

  const appPrefix = path.join(prefixRoot, APP_ID);
  const entrypoint = path.join(appPrefix, 'swir-wine-e2e.exe');
  const manifest = {
    schema: 'swir.package-provider/0.2',
    id: APP_ID,
    targetEditions: ['system'],
    executionClass: 'windows-compat',
    provider: PROVIDER,
    package: { nativeEntryPoint: entrypoint },
    compatibility: { prefixPolicy: 'per-app', windowsArchitecture: 'win64' },
    trust: { signatureRequired: true }
  };

  const prepared = stack.prepare(manifest, { trustVerified: true });
  const realPrefixRoot = fs.realpathSync(prefixRoot);
  const realPrefix = fs.realpathSync(prepared.prefix);
  assert(within(realPrefix, realPrefixRoot), 'PREFIX_ESCAPE', 'Managed Wine prefix escaped its configured root');
  const metadataFile = path.join(realPrefix, '.swir-compat.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  assert(metadata.appId === APP_ID && metadata.provider === PROVIDER && metadata.architecture === 'win64', 'PREFIX_METADATA_INVALID', 'Managed prefix metadata is not bound to this app/runtime');

  fs.copyFileSync(fixture, entrypoint, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(entrypoint, 0o600);
  const marker = path.join(realPrefix, MARKER_NAME);
  fs.rmSync(marker, { force: true });

  const environment = {
    HOME: home,
    USER: 'swir-e2e',
    LOGNAME: 'swir-e2e',
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8'
  };
  const plan = stack.plan(manifest, { trustVerified: true, environment });
  assert(plan.shell === false && plan.brokerRequired === true, 'LAUNCH_BOUNDARY_INVALID', 'Compatibility launch must stay shell-free and broker-bound');
  assert(plan.runtime?.executable === runtime.executable, 'RUNTIME_SELECTION_MISMATCH', 'Launch plan did not select the trusted discovered Wine runtime');
  assert(plan.prefix === realPrefix && plan.application?.executable === fs.realpathSync(entrypoint), 'LAUNCH_PATH_MISMATCH', 'Launch plan escaped managed paths');
  assert(plan.trust?.verified === true && plan.trust?.signatureRequired === true, 'LAUNCH_TRUST_INVALID', 'Compatibility launch trust binding is missing');

  const started = stack.launch(manifest, { trustVerified: true, environment, stdio: 'ignore' });
  assert(Number.isInteger(started.pid) && started.pid > 1 && started.state === 'running', 'PROCESS_NOT_STARTED', 'Wine process did not start');
  const terminal = await waitForTerminal(stack, APP_ID);
  assert(terminal.state === 'exited' && terminal.exitCode === 0 && terminal.signal === null, 'PROCESS_FAILED', `Wine process failed: state=${terminal.state} exit=${terminal.exitCode}`);
  assert(fs.existsSync(marker), 'WINDOWS_MARKER_MISSING', 'Windows fixture did not create its execution marker');
  const markerContent = fs.readFileSync(marker, 'utf8').trim();
  assert(markerContent === EXPECTED_MARKER, 'WINDOWS_MARKER_INVALID', 'Windows fixture marker content is invalid');
  assert(stack.forget(APP_ID) === true, 'PROCESS_RECORD_NOT_RELEASED', 'Terminal compatibility process record could not be released');

  return Object.freeze({
    schema: 'swir.windows-compat-live-e2e/0.1',
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    provider: PROVIDER,
    runtimeFamily: runtime.family,
    runtimeExecutable: runtime.executable,
    runtimeVersion: runtime.version,
    runtimeRootOwned: runtime.trust.rootOwned,
    runtimeWritableByGroupOrWorld: runtime.trust.writableByGroupOrWorld,
    runtimeHealthy: runtime.healthy,
    prefixPolicy: description.prefixPolicy,
    prefixContained: true,
    metadataBound: true,
    trustVerified: plan.trust.verified,
    signatureRequired: plan.trust.signatureRequired,
    brokerRequired: plan.brokerRequired,
    shellExecution: plan.shell,
    windowsExecutableExtension: '.exe',
    processStarted: true,
    processExited: true,
    exitCode: terminal.exitCode,
    markerProduced: true,
    markerContent,
    arbitraryRuntimeDownloadAllowed: description.arbitraryRuntimeDownloadAllowed,
    windowsKernelDriverSupport: ManagedWindowsCompatibilityPolicy.directWindowsKernelDriverSupport,
    realWineExecution: true,
    passed: true
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const evidence = await runWindowsCompatibilityLiveE2E(args);
    const json = `${JSON.stringify(evidence, null, args.compact ? 0 : 2)}\n`;
    if (args.output) fs.writeFileSync(args.output, json, { encoding: 'utf8', mode: 0o600, flag: 'w' });
    else process.stdout.write(json);
  } catch (error) {
    process.stderr.write(`${error?.code || error?.name || 'ERROR'}: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
