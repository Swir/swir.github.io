#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILE_SCHEMA = 'swir.system-reference-image-profile/0.1';
const OFFICIAL_MIRROR = 'https://archive.ubuntu.com/ubuntu';
const OFFICIAL_SECURITY_MIRROR = 'https://security.ubuntu.com/ubuntu';
const SAFE_TOKEN = /^[a-z0-9][a-z0-9+.-]{0,127}$/;
const REQUIRED_E2E_PACKAGES = Object.freeze([
  'ca-certificates',
  'systemd',
  'policykit-1',
  'network-manager',
  'nodejs',
  'fwupd',
  'flatpak'
]);
const ALLOWED_FIRMWARE_SOURCES = new Set(['linux-firmware', 'fwupd-lvfs']);
const ALLOWED_WINDOWS_RUNTIMES = new Set(['wine', 'proton']);

export class ReferenceImageProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReferenceImageProfileError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReferenceImageProfileError(code, message);
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeToken(value, label) {
  assert(typeof value === 'string' && SAFE_TOKEN.test(value), 'UNSAFE_PROFILE_TOKEN', `${label} contains unsupported characters`);
  return value;
}

function assertUniqueSafeList(values, label) {
  assert(Array.isArray(values) && values.length > 0, 'INVALID_PROFILE_LIST', `${label} must be a non-empty array`);
  const normalized = values.map((value, index) => assertSafeToken(value, `${label}[${index}]`));
  assert(new Set(normalized).size === normalized.length, 'DUPLICATE_PROFILE_ENTRY', `${label} must not contain duplicates`);
  return normalized;
}

export function validateReferenceImageProfile(profile) {
  assert(isObject(profile), 'INVALID_PROFILE', 'reference image profile must be an object');
  assert(profile.schema === PROFILE_SCHEMA, 'INVALID_PROFILE_SCHEMA', `profile schema must be ${PROFILE_SCHEMA}`);
  assert(profile.id === 'ubuntu-24.04-amd64', 'UNSUPPORTED_REFERENCE_PROFILE', '0.1 supports only the Ubuntu 24.04 amd64 reference profile');
  assert(profile.status === 'reference-e2e', 'INVALID_PROFILE_STATUS', 'reference profile must stay in reference-e2e status until boot E2E exists');

  const distro = profile.distribution;
  assert(isObject(distro), 'INVALID_DISTRIBUTION', 'distribution section is required');
  assert(distro.id === 'ubuntu' && distro.versionId === '24.04' && distro.suite === 'noble', 'UNSUPPORTED_REFERENCE_DISTRIBUTION', 'reference distribution must be Ubuntu 24.04 noble');
  assert(distro.architecture === 'amd64', 'UNSUPPORTED_REFERENCE_ARCH', '0.1 reference E2E is pinned to amd64');
  assert(distro.mirror === OFFICIAL_MIRROR, 'UNTRUSTED_REFERENCE_MIRROR', 'reference image mirror must be the pinned official Ubuntu archive');
  assert(distro.securityMirror === OFFICIAL_SECURITY_MIRROR, 'UNTRUSTED_SECURITY_MIRROR', 'reference security mirror must be the pinned official Ubuntu security archive');
  assert(Array.isArray(distro.components) && distro.components.length === 2 && distro.components[0] === 'main' && distro.components[1] === 'universe', 'UNSUPPORTED_ARCHIVE_COMPONENTS', 'reference profile must use only Ubuntu main and universe components');

  const sourcePolicy = profile.sourcePolicy;
  assert(isObject(sourcePolicy), 'INVALID_SOURCE_POLICY', 'sourcePolicy is required');
  assert(Array.isArray(sourcePolicy.allowedMirrors) && sourcePolicy.allowedMirrors.length === 2 && sourcePolicy.allowedMirrors[0] === OFFICIAL_MIRROR && sourcePolicy.allowedMirrors[1] === OFFICIAL_SECURITY_MIRROR, 'UNTRUSTED_REFERENCE_MIRROR', 'only the pinned official Ubuntu archive and security archive may be used by this reference profile');
  assert(sourcePolicy.allowArbitraryMirrors === false, 'ARBITRARY_MIRRORS_FORBIDDEN', 'arbitrary package mirrors must remain disabled');
  assert(sourcePolicy.packageSignaturesRequired === true, 'PACKAGE_SIGNATURES_REQUIRED', 'package signature verification must remain mandatory');
  assert(sourcePolicy.thirdPartyRepositoriesAllowed === false, 'THIRD_PARTY_REPOSITORIES_FORBIDDEN', 'third-party repositories are outside the reference image trust boundary');

  const packages = profile.packages;
  assert(isObject(packages), 'INVALID_PACKAGE_PROFILE', 'packages section is required');
  const readiness = assertUniqueSafeList(packages.readiness, 'packages.readiness');
  const firmwarePackages = assertUniqueSafeList(packages.firmware, 'packages.firmware');
  const optionalProviders = assertUniqueSafeList(packages.optionalProviders, 'packages.optionalProviders');
  const e2e = assertUniqueSafeList(packages.e2e, 'packages.e2e');
  for (const required of REQUIRED_E2E_PACKAGES) {
    assert(e2e.includes(required), 'MISSING_E2E_PACKAGE', `reference E2E package set is missing ${required}`);
  }
  for (const required of ['systemd', 'policykit-1', 'network-manager', 'nodejs']) {
    assert(readiness.includes(required), 'MISSING_READINESS_PACKAGE', `readiness package set is missing ${required}`);
  }
  assert(firmwarePackages.includes('linux-firmware') && firmwarePackages.includes('fwupd'), 'MISSING_FIRMWARE_FOUNDATION', 'firmware package set must contain linux-firmware and fwupd');
  assert(optionalProviders.includes('flatpak') && optionalProviders.includes('wine64'), 'MISSING_OPTIONAL_PROVIDER', 'optional provider set must model Flatpak and Wine');

  const kernel = profile.kernel;
  assert(isObject(kernel), 'INVALID_KERNEL_POLICY', 'kernel policy is required');
  assert(kernel.sourceClass === 'distribution-repository', 'UNTRUSTED_KERNEL_SOURCE', 'kernel must come from the selected distribution repository');
  assertSafeToken(kernel.metaPackage, 'kernel.metaPackage');
  assert(kernel.metaPackage === 'linux-generic', 'UNEXPECTED_KERNEL_META_PACKAGE', 'reference kernel meta-package must stay linux-generic');
  assert(kernel.inTreeDriversPreferred === true, 'IN_TREE_DRIVERS_REQUIRED', 'in-tree Linux drivers must remain the primary hardware path');

  const firmware = profile.firmware;
  assert(isObject(firmware), 'INVALID_FIRMWARE_POLICY', 'firmware policy is required');
  const firmwareSources = assertUniqueSafeList(firmware.sourceClasses, 'firmware.sourceClasses');
  assert(firmwareSources.every(source => ALLOWED_FIRMWARE_SOURCES.has(source)), 'UNTRUSTED_FIRMWARE_SOURCE', 'reference image contains an unsupported firmware source class');
  assert(firmwareSources.includes('linux-firmware') && firmwareSources.includes('fwupd-lvfs'), 'MISSING_FIRMWARE_SOURCE', 'linux-firmware and fwupd-lvfs must both be modeled');
  assert(firmware.randomBinaryDownloadsAllowed === false, 'RANDOM_FIRMWARE_DOWNLOADS_FORBIDDEN', 'random firmware binary downloads must remain disabled');

  const windows = profile.windowsCompatibility;
  assert(isObject(windows), 'INVALID_WINDOWS_COMPAT_POLICY', 'windowsCompatibility policy is required');
  const runtimes = assertUniqueSafeList(windows.runtimeClasses, 'windowsCompatibility.runtimeClasses');
  assert(runtimes.every(runtime => ALLOWED_WINDOWS_RUNTIMES.has(runtime)), 'UNSUPPORTED_WINDOWS_RUNTIME', 'only Wine/Proton runtime classes are supported by the reference profile');
  assert(windows.windowsKernelDriversAsLinuxDrivers === false, 'WINDOWS_KERNEL_DRIVERS_FORBIDDEN', 'Windows kernel drivers are not a Linux hardware-driver strategy');

  assert(profile.bootableImageClaim === false, 'PREMATURE_BOOTABLE_CLAIM', 'reference rootfs profile cannot claim bootability before VM boot E2E passes');
  return profile;
}

export function loadReferenceImageProfile(profilePath = new URL('./reference-image-profile.json', import.meta.url)) {
  const resolved = profilePath instanceof URL ? fileURLToPath(profilePath) : path.resolve(String(profilePath));
  const profile = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return validateReferenceImageProfile(profile);
}

export const SystemReferenceImagePolicy = Object.freeze({
  schema: PROFILE_SCHEMA,
  referenceDistribution: 'ubuntu-24.04-noble',
  referenceArchitecture: 'amd64',
  officialMirror: OFFICIAL_MIRROR,
  officialSecurityMirror: OFFICIAL_SECURITY_MIRROR,
  arbitraryMirrors: false,
  thirdPartyRepositories: false,
  packageSignaturesRequired: true,
  randomFirmwareDownloads: false,
  windowsKernelDriversAsLinuxDrivers: false,
  bootableImageClaim: false
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const known = new Set(['--validate', '--json', '--mirror', '--security-mirror', '--suite', '--architecture', '--components', '--e2e-packages']);
  for (const arg of args) assert(known.has(arg), 'UNKNOWN_ARGUMENT', `Unknown argument: ${arg}`);
  const profile = loadReferenceImageProfile();
  if (args.includes('--mirror')) process.stdout.write(`${profile.distribution.mirror}\n`);
  else if (args.includes('--security-mirror')) process.stdout.write(`${profile.distribution.securityMirror}\n`);
  else if (args.includes('--components')) process.stdout.write(`${profile.distribution.components.join(' ')}\n`);
  else if (args.includes('--suite')) process.stdout.write(`${profile.distribution.suite}\n`);
  else if (args.includes('--architecture')) process.stdout.write(`${profile.distribution.architecture}\n`);
  else if (args.includes('--e2e-packages')) process.stdout.write(`${profile.packages.e2e.join(',')}\n`);
  else if (args.includes('--json')) process.stdout.write(`${JSON.stringify(profile)}\n`);
  else process.stdout.write(`Reference image profile OK: ${profile.id}\n`);
}
