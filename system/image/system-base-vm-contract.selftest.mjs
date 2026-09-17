import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SystemImageReadinessPolicy, evaluateSystemImageReadiness } from './system-image-readiness.mjs';
import { PeerAuthorizationProvisioningPolicy } from './system-peer-authorization-provisioning.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const profile = JSON.parse(fs.readFileSync(path.join(here, 'debian13-base-image-profile.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(root, 'system/contracts/system-base-image-profile.schema.json'), 'utf8'));
const provisioning = JSON.parse(fs.readFileSync(path.join(here, 'system-image-provisioning.json'), 'utf8'));

assert.equal(profile.schema, 'swir.system-base-image-profile/0.1');
assert.equal(schema.properties?.schema?.const, profile.schema);
assert.equal(profile.distribution.id, 'debian');
assert.equal(profile.distribution.majorVersion, 13);
assert.equal(profile.distribution.codename, 'trixie');
assert.equal(profile.securityPolicy.repositorySignatureVerificationRequired, true);
assert.equal(profile.securityPolicy.allowUnsignedRepositories, false);
assert.equal(profile.securityPolicy.allowThirdPartyRepositories, false);
assert.equal(profile.securityPolicy.allowRandomBinaryDrivers, false);
assert.equal(profile.securityPolicy.windowsKernelDriversAsLinuxDrivers, false);
assert.equal(profile.bootableImageClaim, false);
assert.equal(profile.directKernelVmE2EClaim, true);
assert.equal(profile.bootloaderE2EClaim, false);

const repoIds = new Set(profile.repositories.map(repo => repo.id));
assert.deepEqual(repoIds, new Set(['debian-main', 'debian-security']));
for (const repo of profile.repositories) {
  assert.equal(repo.signedBy, '/usr/share/keyrings/debian-archive-keyring.gpg');
  assert.match(repo.uri, /^https:\/\/(deb\.debian\.org\/debian|security\.debian\.org\/debian-security)$/);
}
for (const packageName of [...profile.requiredPackages, ...profile.hybridFoundationPackages]) {
  assert.match(packageName, /^[a-z0-9][a-z0-9+.-]*$/);
}
assert.equal(profile.kernelPackages.amd64, 'linux-image-amd64');
assert.ok(profile.requiredPackages.includes('systemd-sysv'));
assert.ok(profile.requiredPackages.includes('polkitd'));
assert.ok(profile.requiredPackages.includes('pkexec'));
assert.ok(profile.requiredPackages.includes('network-manager'));
assert.ok(profile.hybridFoundationPackages.includes('fwupd'));
assert.ok(profile.hybridFoundationPackages.includes('flatpak'));
assert.ok(profile.hybridFoundationPackages.includes('wine'));

assert.ok(SystemImageReadinessPolicy.requiredCore.includes('systemd-session-manager'));
assert.ok(SystemImageReadinessPolicy.requiredCore.includes('polkit-broker'));
assert.ok(SystemImageReadinessPolicy.requiredCore.includes('networkmanager-client'));
assert.ok(SystemImageReadinessPolicy.requiredCore.includes('catalog-trust-state-root'));
assert.equal(SystemImageReadinessPolicy.bootableImageClaim, false);
assert.equal(PeerAuthorizationProvisioningPolicy.runtimeKeyEmbeddedInImage, false);
assert.equal(PeerAuthorizationProvisioningPolicy.bootableImageClaim, false);
assert.equal(provisioning.policy.repositorySignatureVerificationRequired, true);
assert.equal(provisioning.policy.allowArbitraryUrls, false);
assert.equal(provisioning.policy.allowRealRootTarget, false);

const trusted = provider => ({ selected: { provider, realPath: `/usr/bin/${provider}`, trusted: true }, observed: [] });
const evidence = {
  schema: 'swir.system-image-host-evidence/0.1', readOnly: true,
  platform: 'linux', architecture: 'x64', kernelRelease: '6.12-test',
  distribution: { id: 'debian', versionId: '13', prettyName: 'Debian GNU/Linux 13' },
  filesystems: { proc: { available: true }, sys: { available: true } },
  catalogState: { path: '/var/lib/swir/security/catalog-trust', trusted: true },
  binaries: {
    packageManager: trusted('apt'), serviceManager: trusted('systemd'), sessionManager: trusted('systemd-logind'),
    polkit: trusted('polkit'), networkManager: trusted('NetworkManager'), fwupd: trusted('fwupd'), flatpak: trusted('flatpak'), wine: trusted('wine')
  }
};
const report = evaluateSystemImageReadiness(evidence);
assert.equal(report.summary.systemImageReadyForE2E, true);
assert.equal(report.summary.sessionReady, true);
assert.equal(report.summary.optionalPassed, 3);

console.log('System base/VM composition contract self-test: OK');
console.log(`base=${profile.distribution.id}-${profile.distribution.majorVersion} readiness=${report.summary.requiredPassed}/${report.summary.requiredTotal} optional=${report.summary.optionalPassed}/${report.summary.optionalTotal}`);
