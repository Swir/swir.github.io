import assert from 'node:assert/strict';
import {
  GuardedPkexecPackageExecutor,
  PrivilegedPackageExecutorPolicy,
  validatePackageExecutorRequest
} from './privileged-package-executor.mjs';

const digest = 'a'.repeat(64);
const request = {
  schema: 'swir.package-executor-request/0.1',
  transactionId: 'tx-test-0001',
  planDigest: digest,
  manager: 'apt',
  operation: 'install',
  packageName: 'example-editor',
  command: ['apt-get', 'install', '--', 'example-editor']
};

assert.equal(PrivilegedPackageExecutorPolicy.elevationTransport, 'pkexec');
assert.equal(PrivilegedPackageExecutorPolicy.shell, false);
assert.equal(PrivilegedPackageExecutorPolicy.inheritedEnvironment, false);
assert.equal(validatePackageExecutorRequest(request).command[0], 'apt-get');
assert.throws(() => validatePackageExecutorRequest({ ...request, command: ['apt-get', 'install', 'example-editor;id'] }), /allowlisted package-manager shape/);
assert.throws(() => validatePackageExecutorRequest({ ...request, packageName: 'bad;name' }), /invalid package name/);
assert.throws(() => validatePackageExecutorRequest({ ...request, command: ['sh', '-c', 'id'] }), /allowlisted package-manager shape/);

const calls = [];
const rootOwnedStat = () => ({
  isFile: () => true,
  uid: 0,
  mode: 0o100755
});
const runner = async (file, args, options, limits) => {
  calls.push({ file, args, options, limits });
  return { exitCode: 0, signal: null, stdout: 'ok\n', stderr: '' };
};

const executor = new GuardedPkexecPackageExecutor({ statSync: rootOwnedStat, runner, timeoutMs: 2000, maxOutputBytes: 8192 });
const result = await executor.execute(request);
assert.equal(result.ok, true);
assert.equal(result.exitCode, 0);
assert.equal(calls.length, 1);
assert.equal(calls[0].file, '/usr/bin/pkexec');
assert.deepEqual(calls[0].args, ['/usr/bin/apt-get', 'install', '--', 'example-editor']);
assert.equal(calls[0].options.shell, false);
assert.deepEqual(calls[0].options.env, { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
assert.equal(Object.prototype.hasOwnProperty.call(calls[0].options.env, 'HOME'), false);

const rollback = {
  ...request,
  transactionId: 'tx-test-0002',
  manager: 'rpm-ostree',
  operation: 'rollback',
  command: ['rpm-ostree', 'rollback']
};
await executor.execute(rollback);
assert.deepEqual(calls[1].args, ['/usr/bin/rpm-ostree', 'rollback']);

const nonRootExecutor = new GuardedPkexecPackageExecutor({
  statSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100755 }),
  runner
});
await assert.rejects(() => nonRootExecutor.execute(request), /not root-owned/);

const writableExecutor = new GuardedPkexecPackageExecutor({
  statSync: () => ({ isFile: () => true, uid: 0, mode: 0o100775 }),
  runner
});
await assert.rejects(() => writableExecutor.execute(request), /group\/world-writable/);

const failingExecutor = new GuardedPkexecPackageExecutor({
  statSync: rootOwnedStat,
  runner: async () => ({ exitCode: 17, signal: null, stdout: '', stderr: 'package failure' })
});
await assert.rejects(
  () => failingExecutor.execute(request),
  error => error?.code === 'PACKAGE_MANAGER_EXIT_NONZERO' && error.exitCode === 17 && error.stderr === 'package failure'
);

console.log('SWIR guarded pkexec package executor self-tests: OK');
