import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const profile = JSON.parse(fs.readFileSync(path.join(here, 'debian13-base-image-profile.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(here, '..', 'contracts', 'system-base-image-profile.schema.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(profile.schema === 'swir.system-base-image-profile/0.1', 'base image profile schema mismatch');
assert(schema.properties?.schema?.const === profile.schema, 'base image JSON schema does not match profile schema');
assert(profile.status === 'candidate', 'base image must remain candidate until bootable VM E2E exists');
assert(profile.distribution?.id === 'debian' && profile.distribution?.majorVersion === 13 && profile.distribution?.codename === 'trixie', 'base image must stay pinned to Debian 13 trixie');
assert(profile.distribution?.channel === 'stable', 'base image must track the stable Debian channel');
assert(profile.packageManager === 'apt', 'Debian base image must use apt');
assert(profile.bootableImageClaim === false, 'rootfs work must not claim a bootable image');
assert(profile.rootfsE2EClaim === true, 'profile must identify its rootfs E2E scope');

const repositories = new Map(profile.repositories.map(repo => [repo.id, repo]));
assert(repositories.size === 2, 'base image must expose exactly the two approved Debian repositories');
assert(repositories.get('debian-main')?.uri === 'https://deb.debian.org/debian', 'Debian main mirror must use deb.debian.org over HTTPS');
assert(repositories.get('debian-security')?.uri === 'https://security.debian.org/debian-security', 'Debian security mirror must use security.debian.org over HTTPS');
assert(JSON.stringify(repositories.get('debian-main')?.suites) === JSON.stringify(['trixie', 'trixie-updates']), 'Debian main suites must be exactly trixie and trixie-updates');
assert(JSON.stringify(repositories.get('debian-security')?.suites) === JSON.stringify(['trixie-security']), 'Debian security suite must be exactly trixie-security');
for (const repo of repositories.values()) assert(JSON.stringify(repo.components) === JSON.stringify(['main', 'non-free-firmware']), `repository ${repo.id} components must be exactly main and non-free-firmware`);
for (const repo of repositories.values()) {
  assert(repo.uri.startsWith('https://'), `repository ${repo.id} must use HTTPS`);
  assert(repo.signedBy === '/usr/share/keyrings/debian-archive-keyring.gpg', `repository ${repo.id} must use Debian archive keyring`);
  assert(repo.components.every(component => ['main', 'non-free-firmware'].includes(component)), `repository ${repo.id} exposes an unapproved component`);
}

for (const required of ['systemd-sysv', 'dbus', 'polkitd', 'pkexec', 'network-manager', 'ca-certificates', 'nodejs']) {
  assert(profile.requiredPackages.includes(required), `required base package missing: ${required}`);
}
assert(!profile.requiredPackages.includes('policykit-1'), 'Debian 13 must use the split polkitd/pkexec packages instead of the obsolete policykit-1 binary package');
for (const required of ['fwupd', 'flatpak', 'wine', 'wine64', 'firmware-linux-free']) {
  assert(profile.hybridFoundationPackages.includes(required), `hybrid foundation package missing: ${required}`);
}
assert(profile.kernelPackages?.amd64 === 'linux-image-amd64', 'amd64 kernel meta-package mismatch');
assert(profile.kernelPackages?.arm64 === 'linux-image-arm64', 'arm64 kernel meta-package mismatch');

const policy = profile.securityPolicy || {};
assert(policy.allowUnsignedRepositories === false, 'unsigned repositories must stay disabled');
assert(policy.allowThirdPartyRepositories === false, 'third-party repositories must stay disabled in the base profile');
assert(policy.allowRandomBinaryDrivers === false, 'random binary driver downloads must stay disabled');
assert(policy.windowsKernelDriversAsLinuxDrivers === false, 'Windows kernel drivers must not be treated as Linux drivers');
assert(policy.repositorySignatureVerificationRequired === true, 'repository signature verification must remain required');

console.log('Debian 13 base image profile validation: OK');
console.log(`Base: ${profile.distribution.id} ${profile.distribution.majorVersion} (${profile.distribution.codename})`);
console.log(`Architectures: ${profile.architectures.join(', ')}`);
console.log(`Required packages: ${profile.requiredPackages.length}; hybrid foundation packages: ${profile.hybridFoundationPackages.length}`);
console.log('Bootable image claim: false; rootfs E2E scope only');
