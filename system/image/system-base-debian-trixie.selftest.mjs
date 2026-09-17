import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const profile = JSON.parse(fs.readFileSync(path.join(here, 'system-base-debian-trixie.json'), 'utf8'));
const trust = JSON.parse(fs.readFileSync(path.join(here, 'debian-trixie-repository-trust-policy.json'), 'utf8'));
const builder = fs.readFileSync(path.join(here, 'build-debian-trixie-rootfs.sh'), 'utf8');

assert.equal(profile.schema, 'swir.system-base-profile/0.1');
assert.equal(profile.id, 'debian-13-trixie');
assert.equal(profile.status, 'selected-foundation');
assert.equal(profile.distribution.id, 'debian');
assert.equal(profile.distribution.suite, 'trixie');
assert.equal(profile.distribution.majorVersion, 13);
assert.ok(profile.distribution.support.fullUntil >= '2028-08-09');
assert.ok(profile.distribution.support.ltsUntil >= '2030-06-30');
assert.deepEqual(profile.architectures.imageBuilder, ['amd64']);
assert.equal(profile.policy.officialRepositoriesOnly, true);
assert.equal(profile.policy.nativeAptSignatureVerificationRequired, true);
assert.equal(profile.policy.thirdPartyRepositoriesEnabled, false);
assert.equal(profile.policy.randomDriverDownloadsAllowed, false);
assert.equal(profile.policy.windowsKernelDriversSupported, false);
assert.equal(profile.policy.bootableImageClaim, false);
assert.equal(profile.policy.secureBootClaim, false);
assert.equal(profile.policy.hardwareQualificationClaim, false);

const required = new Set(profile.requiredPackages);
for (const name of ['linux-image-amd64', 'systemd-sysv', 'dbus', 'polkitd', 'network-manager', 'fwupd', 'python3', 'ca-certificates', 'debian-archive-keyring']) {
  assert.ok(required.has(name), `required package missing from base profile: ${name}`);
}

const allowedUris = new Set(['https://deb.debian.org/debian', 'https://security.debian.org/debian-security']);
assert.equal(profile.repositories.length, 2);
for (const repo of profile.repositories) {
  assert.ok(allowedUris.has(repo.uri), `unexpected repository URI: ${repo.uri}`);
  assert.equal(repo.signedBy, '/usr/share/keyrings/debian-archive-keyring.gpg');
  assert.equal(repo.sourceClass, 'distribution-repository');
}

assert.equal(trust.schema, 'swir.system-repository-trust-policy/0.1');
assert.equal(trust.defaultRepositoryId, 'debian-main');
assert.deepEqual(new Set(trust.repositories.map(repo => repo.id)), new Set(['debian-main', 'debian-security']));
for (const repo of trust.repositories) {
  assert.equal(repo.manager, 'apt');
  assert.equal(repo.sourceClass, 'distribution-repository');
  assert.deepEqual(repo.distributions, ['debian']);
  assert.equal(repo.signatureVerification, 'native-required');
  assert.equal(repo.allowInsecure, false);
  assert.equal(repo.enabled, true);
}

const forbiddenBuilderTokens = [
  '--no-check-gpg',
  'AllowUnauthenticated=true',
  'APT::Get::AllowUnauthenticated',
  'trusted=yes',
  'curl | sh',
  'wget | sh'
];
for (const token of forbiddenBuilderTokens) {
  assert.equal(builder.includes(token), false, `builder contains forbidden trust bypass token: ${token}`);
}
for (const token of [
  'https://deb.debian.org/debian',
  'https://security.debian.org/debian-security',
  "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg",
  'mmdebstrap',
  '--variant=minbase',
  'linux-image-amd64',
  'network-manager',
  'fwupd',
  'bootableImageClaim',
  'secureBootClaim'
]) {
  assert.ok(builder.includes(token), `builder is missing required invariant: ${token}`);
}
assert.match(builder, /\[\[ "\$ROOTFS" != "\/" \]\]/);
assert.match(builder, /rootfs directory must be empty/);
assert.match(builder, /only the verified amd64 builder is enabled in 0\.1/);

console.log('SWIR Debian 13 base profile self-test OK');
