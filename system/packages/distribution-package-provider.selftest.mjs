import assert from 'node:assert/strict';
import {
  DistributionPackageProvider,
  DistributionPackageProviderPolicy,
  buildDistributionPackagePlan,
  selectDistributionPackageManager,
  validateDistributionPackageManifest
} from './distribution-package-provider.mjs';

assert.equal(DistributionPackageProviderPolicy.previewOnly, true);
assert.equal(DistributionPackageProviderPolicy.autoExecutable, false);
assert.equal(DistributionPackageProviderPolicy.signatureVerificationRequired, true);
assert.equal(DistributionPackageProviderPolicy.arbitraryRepositoryUrls, false);
assert.equal(DistributionPackageProviderPolicy.privilegedMutationRequiresJournal, true);

const aptHost = {
  distribution: { id: 'ubuntu', versionId: '24.04', prettyName: 'Ubuntu', family: 'debian' },
  capabilities: { packageManagers: ['dnf', 'apt'], repositoryConfig: [{ manager: 'apt', path: '/etc/apt/sources.list.d' }] }
};
const fedoraHost = {
  distribution: { id: 'fedora', versionId: '42', prettyName: 'Fedora', family: 'fedora' },
  capabilities: { packageManagers: ['dnf', 'rpm-ostree'] }
};

assert.equal(selectDistributionPackageManager(aptHost).selected, 'apt');
assert.equal(selectDistributionPackageManager(fedoraHost).selected, 'rpm-ostree');
assert.equal(selectDistributionPackageManager({ capabilities: { packageManagers: [] } }).selected, null);

const manifest = {
  schema: 'swir.package-provider/0.2',
  id: 'org.example.editor',
  targetEditions: ['system'],
  executionClass: 'linux-native',
  provider: 'swir.package.system',
  package: {
    name: 'Example Editor',
    sourceRef: 'example-editor',
    nativeEntryPoint: '/usr/bin/example-editor'
  },
  trust: {
    sourceClass: 'distribution-repository',
    repositoryId: 'ubuntu-main',
    signatureRequired: true
  },
  rollback: true
};

assert.equal(validateDistributionPackageManifest(manifest).packageName, 'example-editor');
assert.throws(() => validateDistributionPackageManifest({ ...manifest, executionClass: 'windows-compat' }), /linux-native only/);
assert.throws(() => validateDistributionPackageManifest({ ...manifest, provider: 'swir.package.flatpak' }), /requires swir.package.system/);
assert.throws(() => validateDistributionPackageManifest({ ...manifest, package: { ...manifest.package, sourceRef: 'pkg;rm -rf /' } }), /invalid distribution package/);
assert.throws(() => validateDistributionPackageManifest({ ...manifest, trust: { ...manifest.trust, sourceClass: 'local-user-selected' } }), /distribution-repository trust/);
assert.throws(() => validateDistributionPackageManifest({ ...manifest, trust: { ...manifest.trust, signatureRequired: false } }), /signatures must be required/);

const install = buildDistributionPackagePlan('install', manifest, {
  host: aptHost,
  allowlistedRepositories: ['ubuntu-main']
});
assert.equal(install.schema, 'swir.system-package-plan/0.1');
assert.equal(install.mode, 'preview');
assert.equal(install.readOnly, true);
assert.equal(install.autoExecutable, false);
assert.equal(install.host.packageManager, 'apt');
assert.deepEqual(install.commandPreview, ['apt-get', 'install', '--', 'example-editor']);
assert.equal(install.trust.signatureVerificationRequired, true);
assert.equal(install.trust.arbitraryRepositoryUrlAllowed, false);
assert.equal(install.transaction.requiresPrivilege, true);
assert.equal(install.transaction.journalRequired, true);

const update = buildDistributionPackagePlan('update', manifest, { host: aptHost, allowlistedRepositories: ['ubuntu-main'] });
assert.deepEqual(update.commandPreview, ['apt-get', 'install', '--only-upgrade', '--', 'example-editor']);
const remove = buildDistributionPackagePlan('remove', manifest, { host: aptHost, allowlistedRepositories: ['ubuntu-main'] });
assert.deepEqual(remove.commandPreview, ['apt-get', 'remove', '--', 'example-editor']);
assert.equal(remove.transaction.healthCheckRequired, false);

const rpmPlan = buildDistributionPackagePlan('install', manifest, { host: fedoraHost, allowlistedRepositories: ['ubuntu-main'] });
assert.equal(rpmPlan.host.packageManager, 'rpm-ostree');
assert.equal(rpmPlan.transaction.rollback.supported, true);
assert.deepEqual(rpmPlan.commandPreview, ['rpm-ostree', 'install', '--', 'example-editor']);

assert.throws(() => buildDistributionPackagePlan('install', manifest, { host: aptHost, allowlistedRepositories: ['other'] }), /not allowlisted/);
assert.throws(() => buildDistributionPackagePlan('install', manifest, { host: aptHost, manager: 'zypper', allowlistedRepositories: ['ubuntu-main'] }), /not available on host/);
assert.throws(() => buildDistributionPackagePlan('upgrade-everything', manifest, { host: aptHost }), /unsupported package operation/);

const provider = new DistributionPackageProvider({ host: aptHost, allowlistedRepositories: ['ubuntu-main'] });
assert.equal(provider.probe().available, true);
assert.equal(provider.probe().selectedPackageManager, 'apt');
assert.equal(provider.resolve(manifest).state, 'unqueried');
assert.equal(provider.planInstall(manifest).operation, 'install');
assert.equal(provider.planUpdate(manifest).operation, 'update');
assert.equal(provider.planRemove(manifest).operation, 'remove');
assert.throws(() => provider.install(), /PACKAGE_MUTATION_BROKER_REQUIRED/);
assert.throws(() => provider.update(), /PACKAGE_MUTATION_BROKER_REQUIRED/);
assert.throws(() => provider.remove(), /PACKAGE_MUTATION_BROKER_REQUIRED/);
assert.throws(() => provider.rollback(), /PACKAGE_MUTATION_BROKER_REQUIRED/);

console.log('SWIR distribution package provider self-tests: OK');
