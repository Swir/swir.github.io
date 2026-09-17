import assert from 'node:assert/strict';
import {
  FlatpakUserPackageAdapter,
  FlatpakUserPackagePolicy,
  GuardedFlatpakUserExecutor,
  buildFlatpakUserPlan,
  validateFlatpakManifest,
  validateFlatpakUserPlan
} from './flatpak-user-package-provider.mjs';

const manifest = {
  schema: 'swir.package-provider/0.2',
  id: 'org.example.flateditor',
  targetEditions: ['system'],
  executionClass: 'linux-native',
  provider: 'swir.package.flatpak',
  package: { name: 'Flat Editor', sourceRef: 'org.example.FlatEditor', nativeEntryPoint: 'org.example.FlatEditor', remote: 'flathub', scope: 'user' },
  trust: { sourceClass: 'flatpak-remote', repositoryId: 'flathub', signatureRequired: true }
};

const trustedBinary = () => ({ isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100755, realpath: '/usr/bin/flatpak' });
const remoteProbe = (binary, args, options) => {
  assert.equal(binary, '/usr/bin/flatpak');
  assert.equal(options.shell, false);
  assert.deepEqual(Object.keys(options.env).sort(), ['LANG', 'LC_ALL', 'PATH']);
  if (args[0] === '--user' && args[1] === 'remotes') return { status: 0, stdout: 'flathub\tuser\n', stderr: '' };
  return { status: 0, stdout: 'ok', stderr: '' };
};

assert.deepEqual(validateFlatpakManifest(manifest, { allowlistedRemotes: ['flathub'] }), {
  appId: 'org.example.FlatEditor',
  remote: 'flathub'
});

const install = buildFlatpakUserPlan('install', manifest, { allowlistedRemotes: ['flathub'] });
assert.equal(install.command.executable, '/usr/bin/flatpak');
assert.deepEqual([...install.command.args], ['--user', '--noninteractive', 'install', '--or-update', 'flathub', 'org.example.FlatEditor']);
assert.equal(install.transaction.requiresPrivilege, false);
assert.equal(install.trust.arbitraryRemoteUrlAllowed, false);
assert.equal(install.trust.runtimeRemoteGpgVerificationRequired, true);
validateFlatpakUserPlan(install, { allowlistedRemotes: ['flathub'] });

const update = buildFlatpakUserPlan('update', manifest, { allowlistedRemotes: ['flathub'] });
assert.deepEqual([...update.command.args], ['--user', '--noninteractive', 'update', 'org.example.FlatEditor']);
const remove = buildFlatpakUserPlan('remove', manifest, { allowlistedRemotes: ['flathub'] });
assert.deepEqual([...remove.command.args], ['--user', '--noninteractive', 'uninstall', 'org.example.FlatEditor']);

assert.throws(() => buildFlatpakUserPlan('install', { ...manifest, package: { ...manifest.package, remote: 'evil' }, trust: { ...manifest.trust, repositoryId: 'evil' } }, { allowlistedRemotes: ['flathub'] }), error => error?.code === 'REMOTE_NOT_ALLOWLISTED');
assert.throws(() => validateFlatpakManifest({ ...manifest, package: { ...manifest.package, scope: 'system' } }, { allowlistedRemotes: ['flathub'] }), error => error?.code === 'SYSTEM_SCOPE_NOT_SUPPORTED');
assert.throws(() => validateFlatpakManifest({ ...manifest, package: { ...manifest.package, sourceRef: '--command=sh' } }, { allowlistedRemotes: ['flathub'] }), error => error?.code === 'INVALID_APP_ID');
assert.throws(() => buildFlatpakUserPlan('install', { ...manifest, trust: { ...manifest.trust, signatureRequired: false } }, { allowlistedRemotes: ['flathub'] }), error => error?.code === 'SIGNATURE_REQUIRED');

const tampered = JSON.parse(JSON.stringify(install));
tampered.command.args.push('--command=sh');
assert.throws(() => validateFlatpakUserPlan(tampered, { allowlistedRemotes: ['flathub'] }), error => error?.code === 'ARGUMENT_POLICY_VIOLATION');
const weakened = JSON.parse(JSON.stringify(install));
weakened.trust.runtimeRemoteGpgVerificationRequired = false;
assert.throws(() => validateFlatpakUserPlan(weakened, { allowlistedRemotes: ['flathub'] }), error => error?.code === 'REMOTE_GPG_POLICY_REQUIRED');

const invocations = [];
const executor = new GuardedFlatpakUserExecutor({
  allowlistedRemotes: ['flathub'],
  fileProbe: trustedBinary,
  runner(binary, args, options) {
    invocations.push({ binary, args, options });
    return remoteProbe(binary, args, options);
  }
});
const trust = executor.probe('flathub');
assert.equal(trust.trustedBinary, true);
assert.equal(trust.configured, true);
assert.equal(trust.disabled, false);
assert.equal(trust.oci, false);
assert.equal(trust.gpgVerify, true);
assert.deepEqual([...trust.options], ['user']);
invocations.length = 0;
const adapter = new FlatpakUserPackageAdapter({ allowlistedRemotes: ['flathub'], executor });
const executed = await adapter.execute('install', manifest, { ignored: true });
assert.equal(executed.state, 'committed');
assert.equal(executed.provider, 'swir.package.flatpak');
assert.equal(executed.runtimeTrust.gpgVerify, true);
assert.equal(invocations.length, 2);
assert.deepEqual(invocations[0].args, ['--user', 'remotes', '--columns=name,options']);
assert.deepEqual(invocations[1].args, ['--user', '--noninteractive', 'install', '--or-update', 'flathub', 'org.example.FlatEditor']);
assert.equal(invocations[1].options.shell, false);
assert.deepEqual(await adapter.recoverPending(), []);

// An empty options column is a valid GPG-enabled remote; keep the trailing tab in the fixture.
const noOptions = new GuardedFlatpakUserExecutor({ allowlistedRemotes: ['flathub'], fileProbe: trustedBinary, runner: () => ({ status: 0, stdout: 'flathub\t\n', stderr: '' }) });
assert.equal(noOptions.probe('flathub').gpgVerify, true);
const badOwner = new GuardedFlatpakUserExecutor({ allowlistedRemotes: ['flathub'], fileProbe: () => ({ isFile: true, isSymbolicLink: false, uid: 1000, mode: 0o100755, realpath: '/usr/bin/flatpak' }), runner: remoteProbe });
assert.throws(() => badOwner.probe('flathub'), error => error?.code === 'FLATPAK_BINARY_UNTRUSTED');
const writableBinary = new GuardedFlatpakUserExecutor({ allowlistedRemotes: ['flathub'], fileProbe: () => ({ isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100777, realpath: '/usr/bin/flatpak' }), runner: remoteProbe });
assert.throws(() => writableBinary.probe('flathub'), error => error?.code === 'FLATPAK_BINARY_UNTRUSTED');
const missingRemote = new GuardedFlatpakUserExecutor({ allowlistedRemotes: ['flathub'], fileProbe: trustedBinary, runner: () => ({ status: 0, stdout: 'other\tuser\n', stderr: '' }) });
assert.throws(() => missingRemote.probe('flathub'), error => error?.code === 'FLATPAK_REMOTE_NOT_CONFIGURED');
const unsignedRemote = new GuardedFlatpakUserExecutor({ allowlistedRemotes: ['flathub'], fileProbe: trustedBinary, runner: () => ({ status: 0, stdout: 'flathub\tuser,no-gpg-verify\n', stderr: '' }) });
assert.throws(() => unsignedRemote.probe('flathub'), error => error?.code === 'FLATPAK_REMOTE_GPG_REQUIRED');
const disabledRemote = new GuardedFlatpakUserExecutor({ allowlistedRemotes: ['flathub'], fileProbe: trustedBinary, runner: () => ({ status: 0, stdout: 'flathub\tuser,disabled\n', stderr: '' }) });
assert.throws(() => disabledRemote.probe('flathub'), error => error?.code === 'FLATPAK_REMOTE_DISABLED');
const ociRemote = new GuardedFlatpakUserExecutor({ allowlistedRemotes: ['flathub'], fileProbe: trustedBinary, runner: () => ({ status: 0, stdout: 'flathub\tuser,oci\n', stderr: '' }) });
assert.throws(() => ociRemote.probe('flathub'), error => error?.code === 'FLATPAK_REMOTE_GPG_REQUIRED');
const failedProbe = new GuardedFlatpakUserExecutor({ allowlistedRemotes: ['flathub'], fileProbe: trustedBinary, runner: () => ({ status: 1, stdout: '', stderr: 'denied' }) });
assert.throws(() => failedProbe.probe('flathub'), error => error?.code === 'FLATPAK_REMOTE_PROBE_FAILED');

let calls = 0;
const failedExecutor = new GuardedFlatpakUserExecutor({
  allowlistedRemotes: ['flathub'],
  fileProbe: trustedBinary,
  runner(binary, args, options) {
    calls += 1;
    if (calls === 1) return { status: 0, stdout: 'flathub\tuser\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'denied' };
  }
});
assert.throws(() => failedExecutor.execute(install), error => error?.code === 'FLATPAK_COMMAND_FAILED');

assert.equal(FlatpakUserPackagePolicy.scope, 'user');
assert.equal(FlatpakUserPackagePolicy.arbitraryRemoteUrls, false);
assert.equal(FlatpakUserPackagePolicy.shellAllowed, false);
assert.equal(FlatpakUserPackagePolicy.binaryTrustRequired, true);
assert.equal(FlatpakUserPackagePolicy.runtimeRemoteGpgVerificationRequired, true);
assert.equal(FlatpakUserPackagePolicy.ociRemotesAllowed, false);
assert.equal(FlatpakUserPackagePolicy.disabledRemotesAllowed, false);
assert.equal(FlatpakUserPackagePolicy.versionAwareRollbackImplemented, false);

console.log('Flatpak user Package Provider supported-options runtime-trust self-test: OK');