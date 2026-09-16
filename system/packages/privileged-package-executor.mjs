import fs from 'node:fs';
import { spawn } from 'node:child_process';

const DEFAULT_EXECUTABLES = Object.freeze({
  'apt-get': '/usr/bin/apt-get',
  dnf: '/usr/bin/dnf',
  'rpm-ostree': '/usr/bin/rpm-ostree',
  pacman: '/usr/bin/pacman',
  zypper: '/usr/bin/zypper'
});

const SAFE_ENVIRONMENT = Object.freeze({
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8'
});

const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9+._:@-]{0,127}$/;

function fail(code, message) {
  const error = new Error(message);
  error.name = 'PrivilegedPackageExecutorError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function expectedCommand(manager, operation, packageName) {
  assert(PACKAGE_NAME.test(packageName), 'INVALID_PACKAGE_NAME', 'invalid package name');
  if (operation === 'rollback') {
    assert(manager === 'rpm-ostree', 'UNSUPPORTED_ROLLBACK', 'only rpm-ostree deployment rollback is supported');
    return ['rpm-ostree', 'rollback'];
  }
  if (manager === 'apt') {
    if (operation === 'install') return ['apt-get', 'install', '--', packageName];
    if (operation === 'update') return ['apt-get', 'install', '--only-upgrade', '--', packageName];
    if (operation === 'remove') return ['apt-get', 'remove', '--', packageName];
  }
  if (manager === 'dnf') {
    if (operation === 'install' || operation === 'remove') return ['dnf', operation, '--', packageName];
    if (operation === 'update') return ['dnf', 'upgrade', '--', packageName];
  }
  if (manager === 'rpm-ostree') {
    if (operation === 'install') return ['rpm-ostree', 'install', '--', packageName];
    if (operation === 'update') return ['rpm-ostree', 'upgrade'];
    if (operation === 'remove') return ['rpm-ostree', 'uninstall', '--', packageName];
  }
  if (manager === 'pacman') {
    if (operation === 'install') return ['pacman', '-S', '--', packageName];
    if (operation === 'update') return ['pacman', '-S', '--needed', '--', packageName];
    if (operation === 'remove') return ['pacman', '-R', '--', packageName];
  }
  if (manager === 'zypper') {
    if (operation === 'install') return ['zypper', '--non-interactive', 'install', '--', packageName];
    if (operation === 'update') return ['zypper', '--non-interactive', 'update', '--', packageName];
    if (operation === 'remove') return ['zypper', '--non-interactive', 'remove', '--', packageName];
  }
  fail('UNSUPPORTED_PACKAGE_COMMAND', 'unsupported package-manager operation');
}

function stable(value) {
  return JSON.stringify(value);
}

export function validatePackageExecutorRequest(request) {
  assert(request && typeof request === 'object' && !Array.isArray(request), 'INVALID_EXECUTOR_REQUEST', 'executor request must be an object');
  assert(request.schema === 'swir.package-executor-request/0.1', 'INVALID_EXECUTOR_SCHEMA', 'unsupported package executor request schema');
  assert(typeof request.transactionId === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(request.transactionId), 'INVALID_TRANSACTION_ID', 'invalid package transaction id');
  assert(typeof request.planDigest === 'string' && /^[a-f0-9]{64}$/.test(request.planDigest), 'INVALID_PLAN_DIGEST', 'invalid plan digest');
  assert(typeof request.manager === 'string', 'INVALID_MANAGER', 'package manager is required');
  assert(typeof request.operation === 'string', 'INVALID_OPERATION', 'package operation is required');
  assert(typeof request.packageName === 'string' && PACKAGE_NAME.test(request.packageName), 'INVALID_PACKAGE_NAME', 'invalid package name');
  assert(Array.isArray(request.command) && request.command.every(value => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value)), 'INVALID_COMMAND', 'invalid package command');
  const expected = expectedCommand(request.manager, request.operation, request.packageName);
  assert(stable(request.command) === stable(expected), 'COMMAND_MISMATCH', 'executor command does not match allowlisted package-manager shape');
  return { command: expected };
}

function assertTrustedRootExecutable(filePath, statSync = fs.statSync) {
  assert(typeof filePath === 'string' && filePath.startsWith('/'), 'EXECUTABLE_PATH_REQUIRED', 'privileged executable path must be absolute');
  const stat = statSync(filePath);
  assert(stat?.isFile?.() === true, 'EXECUTABLE_NOT_FILE', `privileged executable is not a regular file: ${filePath}`);
  if (Number.isInteger(stat.uid)) assert(stat.uid === 0, 'EXECUTABLE_NOT_ROOT_OWNED', `privileged executable is not root-owned: ${filePath}`);
  if (Number.isInteger(stat.mode)) assert((stat.mode & 0o022) === 0, 'EXECUTABLE_WRITABLE_BY_NON_ROOT', `privileged executable is group/world-writable: ${filePath}`);
}

function defaultRunner(file, args, options, { timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const collect = (kind, chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(reject, Object.assign(new Error('package manager output limit exceeded'), { code: 'PACKAGE_OUTPUT_LIMIT' }));
        return;
      }
      if (kind === 'stdout') stdout += text;
      else stderr += text;
    };

    child.stdout?.on('data', chunk => collect('stdout', chunk));
    child.stderr?.on('data', chunk => collect('stderr', chunk));
    child.on('error', error => finish(reject, error));
    child.on('close', (code, signal) => finish(resolve, { exitCode: code, signal: signal || null, stdout, stderr }));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, Object.assign(new Error('package manager execution timed out'), { code: 'PACKAGE_EXECUTION_TIMEOUT' }));
    }, timeoutMs);
    timer.unref?.();
  });
}

export class GuardedPkexecPackageExecutor {
  #pkexecPath;
  #executables;
  #statSync;
  #runner;
  #timeoutMs;
  #maxOutputBytes;

  constructor({
    pkexecPath = '/usr/bin/pkexec',
    executables = DEFAULT_EXECUTABLES,
    statSync = fs.statSync,
    runner = defaultRunner,
    timeoutMs = 15 * 60 * 1000,
    maxOutputBytes = 512 * 1024
  } = {}) {
    assert(typeof pkexecPath === 'string' && pkexecPath.startsWith('/'), 'PKEXEC_PATH_REQUIRED', 'pkexec path must be absolute');
    assert(executables && typeof executables === 'object' && !Array.isArray(executables), 'INVALID_EXECUTABLE_MAP', 'package executable map is required');
    assert(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 60 * 60 * 1000, 'INVALID_TIMEOUT', 'package execution timeout is outside policy bounds');
    assert(Number.isInteger(maxOutputBytes) && maxOutputBytes >= 4096 && maxOutputBytes <= 8 * 1024 * 1024, 'INVALID_OUTPUT_LIMIT', 'package execution output limit is outside policy bounds');
    this.#pkexecPath = pkexecPath;
    this.#executables = { ...executables };
    this.#statSync = statSync;
    this.#runner = runner;
    this.#timeoutMs = timeoutMs;
    this.#maxOutputBytes = maxOutputBytes;
  }

  async execute(request) {
    const { command } = validatePackageExecutorRequest(request);
    const logicalExecutable = command[0];
    const executable = this.#executables[logicalExecutable];
    assert(typeof executable === 'string' && executable.startsWith('/'), 'EXECUTABLE_NOT_ALLOWLISTED', `package executable is not allowlisted: ${logicalExecutable}`);

    assertTrustedRootExecutable(this.#pkexecPath, this.#statSync);
    assertTrustedRootExecutable(executable, this.#statSync);

    const args = [executable, ...command.slice(1)];
    const options = {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...SAFE_ENVIRONMENT }
    };
    const result = await this.#runner(this.#pkexecPath, args, options, {
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: this.#maxOutputBytes
    });

    assert(result && Number.isInteger(result.exitCode), 'INVALID_EXECUTOR_RESULT', 'package executor runner returned invalid result');
    if (result.exitCode !== 0) {
      const error = new Error(`package manager exited with code ${result.exitCode}`);
      error.name = 'PrivilegedPackageExecutorError';
      error.code = 'PACKAGE_MANAGER_EXIT_NONZERO';
      error.exitCode = result.exitCode;
      error.signal = result.signal || null;
      error.stderr = String(result.stderr || '').slice(0, 4096);
      throw error;
    }

    return {
      schema: 'swir.package-executor-result/0.1',
      ok: true,
      transactionId: request.transactionId,
      manager: request.manager,
      operation: request.operation,
      exitCode: 0,
      signal: result.signal || null,
      stdout: String(result.stdout || '').slice(0, this.#maxOutputBytes),
      stderr: String(result.stderr || '').slice(0, this.#maxOutputBytes)
    };
  }
}

export const PrivilegedPackageExecutorPolicy = Object.freeze({
  schema: 'swir.package-executor-request/0.1',
  elevationTransport: 'pkexec',
  shell: false,
  inheritedEnvironment: false,
  rootOwnedExecutableRequired: true,
  groupWorldWritableExecutableForbidden: true,
  arbitraryExecutableAllowed: false,
  arbitraryArgumentsAllowed: false,
  supportedExecutables: { ...DEFAULT_EXECUTABLES }
});
