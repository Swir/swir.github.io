import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const profile = JSON.parse(fs.readFileSync(path.join(here, 'debian13-base-image-profile.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(here, '..', 'contracts', 'system-base-image-profile.schema.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(profile.schema === 'swir.system-base-image-profile/0.1', 'base image profile schema mismatch');
assert(schema.properties?.schema?.const === profile.schema, 'base image JSON schema does not match profile schema');
assert(profile.status === 'candidate', 'base image must remain candidate until a SWIR-built bootloader image is verified');
assert(profile.distribution?.id === 'debian' && profile.distribution?.majorVersion === 13 && profile.distribution?.codename === 'trixie', 'base image must stay pinned to Debian 13 trixie');
assert(profile.distribution?.channel === 'stable', 'base image must track Debian stable');
assert(profile.packageManager === 'apt', 'Debian base image must use apt');
assert(profile.bootableImageClaim === false, 'direct-kernel VM E2E must not claim the final bootable image milestone');
assert(profile.rootfsE2EClaim === true, 'profile must identify rootfs E2E scope');
assert(profile.directKernelVmE2EClaim === true, 'profile must identify direct-kernel VM E2E scope');
assert(profile.bootloaderE2EClaim === false, 'bootloader E2E remains pending');

const repositories = new Map(profile.repositories.map(repo => [repo.id, repo]));
assert(repositories.size === 2, 'exactly two approved Debian repositories are required');
assert(repositories.get('debian-main')?.uri === 'https://deb.debian.org/debian', 'Debian main must use deb.debian.org over HTTPS');
assert(repositories.get('debian-security')?.uri === 'https://security.debian.org/debian-security', 'Debian security must use security.debian.org over HTTPS');
assert(JSON.stringify(repositories.get('debian-main')?.suites) === JSON.stringify(['trixie', 'trixie-updates']), 'Debian main suites mismatch');
assert(JSON.stringify(repositories.get('debian-security')?.suites) === JSON.stringify(['trixie-security']), 'Debian security suite mismatch');
for (const repo of repositories.values()) {
  assert(repo.signedBy === '/usr/share/keyrings/debian-archive-keyring.gpg', `repository ${repo.id} must use the Debian archive keyring`);
  assert(JSON.stringify(repo.components) === JSON.stringify(['main', 'non-free-firmware']), `repository ${repo.id} components mismatch`);
}
for (const required of ['systemd-sysv', 'dbus', 'polkitd', 'pkexec', 'network-manager', 'ca-certificates', 'nodejs']) {
  assert(profile.requiredPackages.includes(required), `required base package missing: ${required}`);
}
for (const required of ['fwupd', 'flatpak', 'wine', 'wine64', 'firmware-linux-free']) {
  assert(profile.hybridFoundationPackages.includes(required), `hybrid package missing: ${required}`);
}
assert(profile.kernelPackages?.amd64 === 'linux-image-amd64', 'amd64 kernel package mismatch');
assert(profile.kernelPackages?.arm64 === 'linux-image-arm64', 'arm64 kernel package mismatch');
const policy = profile.securityPolicy || {};
assert(policy.allowUnsignedRepositories === false, 'unsigned repositories must stay disabled');
assert(policy.allowThirdPartyRepositories === false, 'third-party repositories must stay disabled');
assert(policy.allowRandomBinaryDrivers === false, 'random binary driver downloads must stay disabled');
assert(policy.windowsKernelDriversAsLinuxDrivers === false, 'Windows kernel drivers must not be treated as Linux drivers');
assert(policy.repositorySignatureVerificationRequired === true, 'repository signature verification must remain mandatory');

console.log('Debian 13 System Edition base profile: OK');
console.log(`base=${profile.distribution.id}-${profile.distribution.majorVersion}/${profile.distribution.codename} architectures=${profile.architectures.join(',')}`);
console.log('claims=rootfs-e2e,direct-kernel-vm-e2e; bootloader/final bootable image claim=false');
