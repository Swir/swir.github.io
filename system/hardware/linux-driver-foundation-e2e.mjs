import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_PROFILE_PACKAGES = ['linux-image-amd64', 'firmware-linux'];
const ALLOWED_REPOSITORY_HOSTS = new Set(['deb.debian.org', 'security.debian.org']);

function fail(code, message) {
  const error = new Error(message);
  error.name = 'LinuxDriverFoundationE2EError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function parseArgs(argv) {
  const out = { rootfs: null, profile: null, output: null, compact: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--rootfs') out.rootfs = argv[++index] || null;
    else if (arg === '--profile') out.profile = argv[++index] || null;
    else if (arg === '--output') out.output = argv[++index] || null;
    else if (arg === '--compact') out.compact = true;
    else fail('UNKNOWN_ARGUMENT', `Unsupported argument: ${arg}`);
  }
  assert(out.rootfs && path.isAbsolute(out.rootfs), 'ROOTFS_REQUIRED', '--rootfs must be an absolute path');
  assert(out.profile && path.isAbsolute(out.profile), 'PROFILE_REQUIRED', '--profile must be an absolute path');
  return out;
}

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeRootfsPath(rootfs, relativePath, label) {
  const root = fs.realpathSync(rootfs);
  const candidate = path.join(root, relativePath);
  const resolved = fs.realpathSync(candidate);
  assert(within(resolved, root), 'ROOTFS_PATH_ESCAPE', `${label} resolves outside the staged rootfs`);
  return resolved;
}

function parseDpkgStatus(rootfs) {
  const statusPath = safeRootfsPath(rootfs, 'var/lib/dpkg/status', 'dpkg status');
  const content = fs.readFileSync(statusPath, 'utf8');
  const installed = new Map();
  for (const stanza of content.split(/\n\n+/)) {
    const fields = {};
    for (const line of stanza.split(/\r?\n/)) {
      const match = /^([^:]+):\s*(.*)$/.exec(line);
      if (match) fields[match[1]] = match[2];
    }
    if (fields.Package && fields.Status === 'install ok installed') installed.set(fields.Package, fields.Version || null);
  }
  return installed;
}

function hasRegularFile(root, { maxEntries = 250000 } = {}) {
  const queue = [root];
  let visited = 0;
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      visited += 1;
      assert(visited <= maxEntries, 'TREE_SCAN_LIMIT', `Filesystem scan exceeded ${maxEntries} entries under ${root}`);
      if (entry.isFile()) return true;
      if (entry.isDirectory()) queue.push(path.join(current, entry.name));
    }
  }
  return false;
}

function countLiveBoundDrivers() {
  const roots = ['/sys/bus/pci/devices', '/sys/bus/usb/devices'];
  const modules = new Set();
  let boundDevices = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const driverLink = path.join(root, name, 'driver');
      if (!fs.existsSync(driverLink)) continue;
      let driverReal;
      try { driverReal = fs.realpathSync(driverLink); } catch { continue; }
      if (!driverReal.startsWith('/sys/bus/') && !driverReal.startsWith('/sys/devices/')) continue;
      boundDevices += 1;
      const moduleLink = path.join(driverLink, 'module');
      if (!fs.existsSync(moduleLink)) continue;
      try {
        const moduleReal = fs.realpathSync(moduleLink);
        if (moduleReal.startsWith('/sys/module/')) modules.add(path.basename(moduleReal));
      } catch {}
    }
  }
  return { boundDevices, modules: [...modules].sort() };
}

function validateProfile(profile) {
  assert(profile?.schema === 'swir.system-base-profile/0.1', 'PROFILE_SCHEMA_INVALID', 'Unexpected base profile schema');
  assert(profile?.id === 'debian-13-trixie', 'PROFILE_ID_INVALID', 'Driver foundation gate is bound to the selected Debian 13 profile');
  assert(profile?.policy?.officialRepositoriesOnly === true, 'OFFICIAL_REPOSITORIES_REQUIRED', 'Official repository policy must remain enabled');
  assert(profile?.policy?.nativeAptSignatureVerificationRequired === true, 'APT_SIGNATURE_POLICY_REQUIRED', 'Native APT signature verification must remain enabled');
  assert(profile?.policy?.randomDriverDownloadsAllowed === false, 'RANDOM_DRIVER_DOWNLOADS_FORBIDDEN', 'Random driver downloads must remain disabled');
  assert(profile?.policy?.windowsKernelDriversSupported === false, 'WINDOWS_KERNEL_DRIVER_POLICY_INVALID', 'Windows kernel drivers cannot be the Linux hardware path');
  const required = new Set(profile.requiredPackages || []);
  for (const packageName of REQUIRED_PROFILE_PACKAGES) {
    assert(required.has(packageName), 'REQUIRED_PACKAGE_MISSING', `Selected base profile must require ${packageName}`);
  }
  for (const repository of profile.repositories || []) {
    assert(repository?.sourceClass === 'distribution-repository', 'UNTRUSTED_REPOSITORY_CLASS', 'Base repositories must use distribution-repository source class');
    const uri = new URL(repository.uri);
    assert(uri.protocol === 'https:', 'REPOSITORY_HTTPS_REQUIRED', 'Base repository must use HTTPS');
    assert(ALLOWED_REPOSITORY_HOSTS.has(uri.hostname), 'REPOSITORY_HOST_NOT_ALLOWLISTED', `Repository host is not allowlisted: ${uri.hostname}`);
    assert(repository.signedBy === '/usr/share/keyrings/debian-archive-keyring.gpg', 'REPOSITORY_KEYRING_INVALID', 'Debian repository must use the distro archive keyring');
  }
  assert((profile.repositories || []).some(repository => (repository.components || []).includes('non-free-firmware')), 'NON_FREE_FIRMWARE_COMPONENT_REQUIRED', 'Debian non-free-firmware component must be explicitly configured');
}

export function runLinuxDriverFoundationE2E({ rootfs, profilePath }) {
  assert(os.platform() === 'linux', 'LINUX_REQUIRED', 'Driver foundation E2E requires Linux');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  validateProfile(profile);

  const root = fs.realpathSync(rootfs);
  assert(root !== '/', 'UNSAFE_ROOTFS', 'Refusing to inspect host root as staged System Edition rootfs');
  const installed = parseDpkgStatus(root);
  for (const packageName of REQUIRED_PROFILE_PACKAGES) {
    assert(installed.has(packageName), 'PACKAGE_NOT_INSTALLED', `${packageName} is not installed in the staged System Edition rootfs`);
  }
  assert(installed.has('firmware-linux-free'), 'FREE_FIRMWARE_NOT_INSTALLED', 'firmware-linux dependency did not provision firmware-linux-free');
  assert(installed.has('firmware-linux-nonfree'), 'NONFREE_FIRMWARE_NOT_INSTALLED', 'firmware-linux dependency did not provision firmware-linux-nonfree');

  const modulesRoot = safeRootfsPath(root, 'usr/lib/modules', 'kernel modules');
  const firmwareRoot = safeRootfsPath(root, 'usr/lib/firmware', 'firmware tree');
  assert(hasRegularFile(modulesRoot), 'KERNEL_MODULES_EMPTY', 'Selected System Edition rootfs contains no kernel module payload');
  assert(hasRegularFile(firmwareRoot), 'FIRMWARE_TREE_EMPTY', 'Selected System Edition rootfs contains no firmware payload');

  const live = countLiveBoundDrivers();
  assert(live.boundDevices > 0, 'NO_LIVE_BOUND_DRIVERS', 'Live Linux host exposes no PCI/USB device bound to a kernel driver');
  assert(live.modules.length > 0, 'NO_LIVE_KERNEL_MODULES', 'No bound PCI/USB driver exposes a Linux kernel module');

  return Object.freeze({
    schema: 'swir.linux-driver-foundation-e2e/0.1',
    generatedAt: new Date().toISOString(),
    selectedBase: profile.id,
    architecture: os.arch(),
    kernelPackage: { name: 'linux-image-amd64', version: installed.get('linux-image-amd64') },
    firmwarePackage: { name: 'firmware-linux', version: installed.get('firmware-linux') },
    firmwareDependencies: {
      free: installed.get('firmware-linux-free'),
      nonfree: installed.get('firmware-linux-nonfree')
    },
    kernelModuleTreePresent: true,
    firmwareTreePresent: true,
    liveKernelBoundDevices: live.boundDevices,
    liveKernelModules: live.modules,
    primaryDriverSourceClass: 'kernel-in-tree',
    primaryFirmwareSourceClass: 'linux-firmware',
    distributionRepositoryOnly: true,
    repositorySignatureVerificationRequired: profile.policy.nativeAptSignatureVerificationRequired === true,
    arbitraryDriverDownloadsAllowed: false,
    windowsKernelDriversSupported: false,
    hardwareQualificationClaim: false,
    passed: true
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const evidence = runLinuxDriverFoundationE2E({ rootfs: args.rootfs, profilePath: args.profile });
    const json = `${JSON.stringify(evidence, null, args.compact ? 0 : 2)}\n`;
    if (args.output) fs.writeFileSync(args.output, json, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(json);
  } catch (error) {
    process.stderr.write(`${error?.code || error?.name || 'ERROR'}: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
