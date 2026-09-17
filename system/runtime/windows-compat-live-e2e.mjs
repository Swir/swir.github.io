import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createManagedWindowsCompatibilityStack, ManagedWindowsCompatibilityPolicy } from './managed-windows-compatibility-stack.mjs';
import { WindowsCompatibilityPolicy } from './windows-compatibility-service.mjs';

function fail(code, message) {
  const error = new Error(message);
  error.name = 'WindowsCompatLiveE2EError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function parseArgs(argv) {
  const out = { fixture: null, prefixRoot: null, output: null, compact: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') out.fixture = argv[++index] || null;
    else if (arg === '--prefix-root') out.prefixRoot = argv[++index] || null;
    else if (arg === '--output') out.output = argv[++index] || null;
    else if (arg === '--compact') out.compact = true;
    else fail('UNKNOWN_ARGUMENT', `Unsupported argument: ${arg}`);
  }
  assert(out.fixture && path.isAbsolute(out.fixture), 'FIXTURE_REQUIRED', '--fixture must be an absolute path');
  assert(out.prefixRoot && path.isAbsolute(out.prefixRoot), 'PREFIX_ROOT_REQUIRED', '--prefix-root must be an absolute path');
  return out;
}

function assertPortableExecutable(file) {
  const stat = fs.statSync(file);
  assert(stat.isFile(), 'FIXTURE_NOT_FILE', 'Windows fixture must be a regular file');
  assert(stat.size > 128 && stat.size < 16 * 1024 * 1024, 'FIXTURE_SIZE_INVALID', 'Windows fixture size is outside the E2E safety bound');
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(64);
    fs.readSync(fd, header, 0, header.length, 0);
    assert(header[0] === 0x4d && header[1] === 0x5a, 'FIXTURE_NOT_PE', 'Windows fixture does not have an MZ header');
    const peOffset = header.readUInt32LE(0x3c);
    assert(peOffset > 0 && peOffset < stat.size - 4, 'FIXTURE_PE_OFFSET_INVALID', 'Windows fixture PE header offset is invalid');
    const signature = Buffer.alloc(4);
    fs.readSync(fd, signature, 0, signature.length, peOffset);
    assert(signature.equals(Buffer.from([0x50, 0x45, 0x00, 0x00])), 'FIXTURE_PE_SIGNATURE_INVALID', 'Windows fixture does not have a PE signature');
  } finally {
    fs.closeSync(fd);
  }
}

async function waitForExit(stack, appId, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const record = stack.get(appId);
    if (record && record.state !== 'running') return record;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  stack.stop(appId, { signal: 'SIGKILL' });
  fail('COMPAT_TIMEOUT', `Compatibility application ${appId} did not exit within ${timeoutMs} ms`);
}

export async function runWindowsCompatLiveE2E({ fixture, prefixRoot }) {
  assertPortableExecutable(fixture);
  assert(prefixRoot !== '/', 'UNSAFE_PREFIX_ROOT', 'Compatibility E2E cannot use filesystem root as prefix root');
  fs.mkdirSync(prefixRoot, { recursive: true, mode: 0o700 });
  const stack = createManagedWindowsCompatibilityStack({ prefixRoot });
  const description = stack.describe();
  assert(description.providers.wine === true, 'WINE_RUNTIME_UNAVAILABLE', 'No trusted healthy Wine runtime was discovered');
  assert(description.arbitraryRuntimeDownloadAllowed === false, 'RUNTIME_DOWNLOAD_POLICY_INVALID', 'Arbitrary runtime downloads must stay disabled');
  assert(description.runtimeRootOwnershipRequired === true, 'RUNTIME_OWNERSHIP_POLICY_INVALID', 'Compatibility runtime must remain root-owned');
  assert(WindowsCompatibilityPolicy.providers.includes('swir.compat.proton'), 'PROTON_CONTRACT_MISSING', 'Compatibility service must retain the Proton provider contract');

  const appId = 'swir.e2e.windows.console';
  const expectedPrefix = path.join(path.resolve(prefixRoot), appId);
  const entryPoint = path.join(expectedPrefix, 'drive_c', 'swir-e2e.exe');
  const manifest = {
    schema: 'swir.package-provider/0.2',
    id: appId,
    targetEditions: ['system'],
    executionClass: 'windows-compat',
    provider: 'swir.compat.wine',
    package: { nativeEntryPoint: entryPoint },
    compatibility: { prefixPolicy: 'per-app', windowsArchitecture: 'win64' },
    trust: { signatureRequired: true }
  };

  const prepared = stack.prepare(manifest, { trustVerified: true });
  assert(prepared.prefix === fs.realpathSync(expectedPrefix), 'PREFIX_IDENTITY_MISMATCH', 'Managed prefix identity mismatch');
  const driveC = path.join(prepared.prefix, 'drive_c');
  fs.mkdirSync(driveC, { recursive: true, mode: 0o700 });
  fs.copyFileSync(fixture, entryPoint, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(entryPoint, 0o600);

  const environment = {
    HOME: process.env.HOME || path.dirname(prefixRoot),
    USER: process.env.USER || 'swir-e2e',
    LOGNAME: process.env.LOGNAME || process.env.USER || 'swir-e2e',
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8'
  };
  const plan = stack.plan(manifest, { trustVerified: true, args: ['--swir-e2e'], environment });
  assert(plan.shell === false, 'SHELL_EXECUTION_FORBIDDEN', 'Windows compatibility launch must not use a shell');
  assert(plan.runtime.family === 'wine', 'WRONG_RUNTIME_FAMILY', 'Live E2E must exercise Wine');
  assert(plan.prefix === prepared.prefix, 'PREFIX_PLAN_MISMATCH', 'Launch plan escaped the prepared prefix');
  assert(plan.application.executable === fs.realpathSync(entryPoint), 'ENTRYPOINT_PLAN_MISMATCH', 'Launch plan did not bind the managed PE entry point');
  assert(plan.trust.verified === true && plan.trust.signatureRequired === true, 'PACKAGE_TRUST_NOT_BOUND', 'Compatibility plan must be trust-bound');

  const started = stack.launch(manifest, { trustVerified: true, args: ['--swir-e2e'], environment, stdio: 'ignore' });
  assert(Number.isInteger(started.pid) && started.pid > 1, 'INVALID_CHILD_PID', 'Wine child process PID is invalid');
  const exited = await waitForExit(stack, appId);
  assert(exited.state === 'exited', 'WINDOWS_APP_FAILED', `Windows fixture did not exit cleanly: ${exited.state}`);
  assert(exited.exitCode === 0 && exited.signal === null, 'WINDOWS_APP_EXIT_INVALID', `Windows fixture exit was ${exited.exitCode}/${exited.signal}`);

  const metadata = JSON.parse(fs.readFileSync(path.join(prepared.prefix, '.swir-compat.json'), 'utf8'));
  assert(metadata.appId === appId && metadata.provider === 'swir.compat.wine' && metadata.prefixPolicy === 'per-app', 'PREFIX_METADATA_INVALID', 'Managed prefix metadata mismatch');

  const wine = stack.inventory().runtimes.find(runtime => runtime.provider === 'swir.compat.wine' && runtime.healthy);
  assert(wine && wine.trust?.rootOwned === true && wine.trust?.writableByGroupOrWorld === false, 'WINE_RUNTIME_UNTRUSTED', 'Wine runtime trust checks failed');

  return Object.freeze({
    schema: 'swir.windows-compat-live-e2e/0.1',
    generatedAt: new Date().toISOString(),
    provider: 'swir.compat.wine',
    runtimeFamily: wine.family,
    runtimeVersion: wine.version,
    runtimeExecutable: wine.executable,
    runtimeRootOwned: wine.trust.rootOwned,
    runtimeWritableByGroupOrWorld: wine.trust.writableByGroupOrWorld,
    actualPortableExecutable: true,
    managedPrefix: true,
    perAppPrefix: true,
    prefixMetadataVerified: true,
    trustVerified: true,
    signatureRequired: true,
    shellExecution: false,
    arbitraryRuntimeDownloadAllowed: ManagedWindowsCompatibilityPolicy.arbitraryRuntimeDownloadAllowed,
    childPidObserved: true,
    exitCode: exited.exitCode,
    protonContractSupported: true,
    protonLiveE2E: false,
    windowsKernelDriverSupport: ManagedWindowsCompatibilityPolicy.directWindowsKernelDriverSupport,
    passed: true
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const evidence = await runWindowsCompatLiveE2E({ fixture: args.fixture, prefixRoot: args.prefixRoot });
    const json = `${JSON.stringify(evidence, null, args.compact ? 0 : 2)}\n`;
    if (args.output) fs.writeFileSync(args.output, json, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(json);
  } catch (error) {
    process.stderr.write(`${error?.code || error?.name || 'ERROR'}: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
