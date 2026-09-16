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
  id: 'org.example.FlatEditor',
  targetEditions: ['system'],
  executionClass: 'linux-native',
  provider: 'swir.package.flatpak',
  package: { name: 'Flat Editor', sourceRef: 'org.example.FlatEditor', nativeEntryPoint: 'org.example.FlatEditor', remote: 'flathub', scope: 'user' },
  trust: { sourceClass: 'flatpak-remote', repositoryId: 'flathub', signatureRequired: true }
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

const invocations = [];
const executor = new GuardedFlatpakUserExecutor({
  allowlistedRemotes: ['flathub'],
  runner(binary, args, options) {
    invocations.push({ binary, args, options });
    return { status: 0, stdout: 'ok', stderr: '' };
  }
});
const adapter = new FlatpakUserPackageAdapter({ allowlistedRemotes: ['flathub'], executor });
const executed = await adapter.execute('install', manifest, { ignored: true });
assert.equal(executed.state, 'committed');
assert.equal(executed.provider, 'swir.package.flatpak');
assert.equal(invocations.length, 1);
assert.equal(invocations[0].binary, '/usr/bin/flatpak');
assert.equal(invocations[0].options.shell, false);
assert.deepEqual(Object.keys(invocations[0].options.env).sort(), ['LANG', 'LC_ALL', 'PATH']);
assert.deepEqual(await adapter.recoverPending(), []);

const failedExecutor = new GuardedFlatpakUserExecutor({
  allowlistedRemotes: ['flathub'],
  runner() { return { status: 1, stdout: '', stderr: 'denied' }; }
});
assert.throws(() => failedExecutor.execute(install), error => error?.code === 'FLATPAK_COMMAND_FAILED');

assert.equal(FlatpakUserPackagePolicy.scope, 'user');
assert.equal(FlatpakUserPackagePolicy.arbitraryRemoteUrls, false);
assert.equal(FlatpakUserPackagePolicy.shellAllowed, false);
assert.equal(FlatpakUserPackagePolicy.versionAwareRollbackImplemented, false);

console.log('Flatpak user Package Provider self-test: OK');
