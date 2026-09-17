import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SystemImageReadinessPolicy } from './system-image-readiness.mjs';
import { SystemSessionIdentityPolicy } from '../session/system-session-identity-service.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const profile = JSON.parse(fs.readFileSync(path.join(here, 'debian13-base-image-profile.json'), 'utf8'));

const allPackages = new Set([...profile.requiredPackages, ...profile.hybridFoundationPackages]);
assert.equal(profile.schema, 'swir.system-base-image-profile/0.1');
assert.equal(profile.distribution.id, 'debian');
assert.equal(profile.distribution.majorVersion, 13);
assert.equal(profile.distribution.codename, 'trixie');
assert.equal(profile.bootableImageClaim, false);
assert.equal(profile.rootfsE2EClaim, true);

for (const packageName of ['systemd-sysv', 'policykit-1', 'network-manager', 'fwupd', 'flatpak', 'wine', 'wine64', 'firmware-linux-free']) {
  assert(allPackages.has(packageName), `base image package set does not satisfy current System foundation: ${packageName}`);
}
assert(SystemImageReadinessPolicy.requiredCore.includes('systemd-service-manager'));
assert(SystemImageReadinessPolicy.requiredCore.includes('systemd-logind-client'));
assert(SystemImageReadinessPolicy.requiredCore.includes('polkit-broker'));
assert(SystemImageReadinessPolicy.requiredCore.includes('networkmanager-client'));
assert.deepEqual(new Set(SystemImageReadinessPolicy.optionalProviders), new Set(['fwupd-discovery', 'flatpak-runtime', 'wine-runtime']));
assert.equal(SystemSessionIdentityPolicy.provider, 'systemd-logind');
assert.equal(SystemSessionIdentityPolicy.binary, '/usr/bin/loginctl');
assert.equal(SystemSessionIdentityPolicy.readOnly, true);
assert.equal(SystemSessionIdentityPolicy.authorizationAuthority, 'polkit-separate');

for (const repo of profile.repositories) {
  assert(repo.uri.startsWith('https://'));
  assert.equal(repo.signedBy, '/usr/share/keyrings/debian-archive-keyring.gpg');
}
assert.equal(profile.securityPolicy.allowUnsignedRepositories, false);
assert.equal(profile.securityPolicy.allowThirdPartyRepositories, false);
assert.equal(profile.securityPolicy.allowRandomBinaryDrivers, false);
assert.equal(profile.securityPolicy.windowsKernelDriversAsLinuxDrivers, false);
assert.equal(profile.securityPolicy.repositorySignatureVerificationRequired, true);

console.log('System base image integration contract: OK');
