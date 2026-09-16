import assert from 'node:assert/strict';
import {
  DistributionPackageSnapshotProvider,
  DistributionPackageStatePolicy,
  NativePackageHealthVerifier
} from './distribution-package-state.mjs';

assert.equal(DistributionPackageStatePolicy.readOnly, true);
assert.equal(DistributionPackageStatePolicy.shellExecution, false);
assert.equal(DistributionPackageStatePolicy.inheritedEnvironment, false);

const calls = [];
const provider = new DistributionPackageSnapshotProvider({
  clock: () => '2026-09-16T20:31:00.000Z',
  runner: async (file, args, limits) => {
    calls.push({ file, args, limits });
    if (file === '/usr/bin/dpkg-query') return { exitCode: 0, signal: null, stdout: 'install ok installed\t1.2.3-1\n', stderr: '' };
    if (file === '/usr/bin/pacman') return { exitCode: 0, signal: null, stdout: 'example-editor 2.0.0-1\n', stderr: '' };
    return { exitCode: 0, signal: null, stdout: '3.4.5-6.fc42\n', stderr: '' };
  }
});

const apt = await provider.capture({ manager: 'apt', packageName: 'example-editor', packageId: 'org.example.editor' });
assert.equal(apt.installed, true);
assert.equal(apt.version, '1.2.3-1');
assert.equal(apt.query.source, 'dpkg-query');
assert.deepEqual(calls[0].args, ['-W', '-f=${Status}\t${Version}\n', 'example-editor']);

const rpm = await provider.capture({ manager: 'dnf', packageName: 'example-editor' });
assert.equal(rpm.installed, true);
assert.equal(rpm.version, '3.4.5-6.fc42');
assert.equal(rpm.query.source, 'rpm');
assert.deepEqual(calls[1].args, ['-q', '--qf', '%{VERSION}-%{RELEASE}\n', 'example-editor']);

const pacman = await provider.capture({ manager: 'pacman', packageName: 'example-editor' });
assert.equal(pacman.installed, true);
assert.equal(pacman.version, '2.0.0-1');
assert.equal(pacman.query.source, 'pacman');

const missing = new DistributionPackageSnapshotProvider({
  runner: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: 'not installed' })
});
const missingState = await missing.capture({ manager: 'apt', packageName: 'missing-package' });
assert.equal(missingState.installed, false);
assert.equal(missingState.version, null);
await assert.rejects(() => provider.capture({ manager: 'apt', packageName: 'bad;name' }), /invalid package name/);
await assert.rejects(() => provider.capture({ manager: 'unknown', packageName: 'example-editor' }), /unsupported package manager/);

const executableStat = { isSymbolicLink: () => false, isFile: () => true };
const health = new NativePackageHealthVerifier({
  lstatSync: () => executableStat,
  realpathSync: value => value,
  accessSync: () => undefined
});
const healthy = await health.verify({
  packageId: 'org.example.editor',
  packageName: 'example-editor',
  nativeEntryPoint: '/usr/bin/example-editor',
  operation: 'install'
});
assert.equal(healthy.healthy, true);
assert.equal(healthy.checks.every(check => check.ok), true);

const escape = new NativePackageHealthVerifier({
  lstatSync: () => ({ isSymbolicLink: () => true, isFile: () => true }),
  realpathSync: () => '/home/user/untrusted-editor',
  accessSync: () => undefined
});
const escaped = await escape.verify({ packageName: 'example-editor', nativeEntryPoint: '/usr/bin/example-editor', operation: 'install' });
assert.equal(escaped.healthy, false);
assert.equal(escaped.checks[0].reason, 'ENTRY_POINT_OUTSIDE_ALLOWED_ROOT');

const nonExecutable = new NativePackageHealthVerifier({
  lstatSync: () => executableStat,
  realpathSync: value => value,
  accessSync: () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; }
});
const blocked = await nonExecutable.verify({ packageName: 'example-editor', nativeEntryPoint: '/opt/example/editor', operation: 'update' });
assert.equal(blocked.healthy, false);
assert.equal(blocked.checks[0].reason, 'ENTRY_POINT_NOT_EXECUTABLE');

const removed = await health.verify({ packageName: 'example-editor', nativeEntryPoint: null, operation: 'remove' });
assert.equal(removed.healthy, true);

console.log('SWIR distribution package state/health self-tests: OK');
