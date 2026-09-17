import assert from 'node:assert/strict';
import { loadReferenceImageProfile, validateReferenceImageProfile } from './reference-image-profile.mjs';

const canonical = loadReferenceImageProfile();
assert.equal(canonical.distribution.id, 'ubuntu');
assert.equal(canonical.distribution.versionId, '24.04');
assert.equal(canonical.distribution.mirror, 'https://archive.ubuntu.com/ubuntu');
assert.equal(canonical.distribution.securityMirror, 'https://security.ubuntu.com/ubuntu');
assert.deepEqual(canonical.distribution.components, ['main', 'universe']);
assert.equal(canonical.vmImage.baseUrl, 'https://cloud-images.ubuntu.com/releases/noble/release');
assert.equal(canonical.vmImage.file, 'ubuntu-24.04-server-cloudimg-amd64.img');
assert.equal(canonical.vmImage.keyring, '/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg');
assert.equal(canonical.vmImage.signatureRequired, true);
assert.equal(canonical.bootableImageClaim, false);
assert(canonical.packages.e2e.includes('network-manager'));
assert(canonical.packages.firmware.includes('linux-firmware'));
assert.equal(canonical.firmware.randomBinaryDownloadsAllowed, false);
assert.equal(canonical.windowsCompatibility.windowsKernelDriversAsLinuxDrivers, false);

function mutated(change) {
  const copy = structuredClone(canonical);
  change(copy);
  return copy;
}

function rejects(code, change) {
  assert.throws(() => validateReferenceImageProfile(mutated(change)), error => error?.code === code, `expected ${code}`);
}

rejects('UNTRUSTED_REFERENCE_MIRROR', profile => { profile.distribution.mirror = 'https://mirror.example.invalid/ubuntu'; });
rejects('UNTRUSTED_SECURITY_MIRROR', profile => { profile.distribution.securityMirror = 'https://security.example.invalid/ubuntu'; });
rejects('UNTRUSTED_VM_IMAGE_SOURCE', profile => { profile.vmImage.baseUrl = 'https://downloads.example.invalid/images'; });
rejects('UNTRUSTED_VM_IMAGE_NAME', profile => { profile.vmImage.file = 'unknown.img'; });
rejects('INVALID_VM_IMAGE_SIGNATURE_METADATA', profile => { profile.vmImage.signature = 'unsigned.txt'; });
rejects('UNTRUSTED_VM_IMAGE_KEYRING', profile => { profile.vmImage.keyring = '/tmp/keyring.gpg'; });
rejects('VM_IMAGE_SIGNATURE_REQUIRED', profile => { profile.vmImage.signatureRequired = false; });
rejects('UNSUPPORTED_ARCHIVE_COMPONENTS', profile => { profile.distribution.components.push('multiverse'); });
rejects('THIRD_PARTY_REPOSITORIES_FORBIDDEN', profile => { profile.sourcePolicy.thirdPartyRepositoriesAllowed = true; });
rejects('PACKAGE_SIGNATURES_REQUIRED', profile => { profile.sourcePolicy.packageSignaturesRequired = false; });
rejects('UNSAFE_PROFILE_TOKEN', profile => { profile.packages.e2e.push('curl;sh'); });
rejects('MISSING_E2E_PACKAGE', profile => { profile.packages.e2e = profile.packages.e2e.filter(name => name !== 'network-manager'); });
rejects('UNTRUSTED_KERNEL_SOURCE', profile => { profile.kernel.sourceClass = 'random-download'; });
rejects('UNTRUSTED_FIRMWARE_SOURCE', profile => { profile.firmware.sourceClasses.push('random-site'); });
rejects('RANDOM_FIRMWARE_DOWNLOADS_FORBIDDEN', profile => { profile.firmware.randomBinaryDownloadsAllowed = true; });
rejects('WINDOWS_KERNEL_DRIVERS_FORBIDDEN', profile => { profile.windowsCompatibility.windowsKernelDriversAsLinuxDrivers = true; });
rejects('PREMATURE_BOOTABLE_CLAIM', profile => { profile.bootableImageClaim = true; });

console.log('Reference image profile self-test OK');
