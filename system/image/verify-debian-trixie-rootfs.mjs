#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const fsp = fs.promises;
const REQUIRED_PACKAGES = Object.freeze(['linux-image-amd64', 'systemd-sysv', 'dbus', 'polkitd', 'network-manager', 'fwupd', 'python3', 'ca-certificates', 'debian-archive-keyring']);
const REQUIRED_BINARIES = Object.freeze(['/usr/bin/systemctl', '/usr/bin/loginctl', '/usr/bin/pkcheck', '/usr/bin/nmcli', '/usr/bin/fwupdmgr', '/usr/bin/python3', '/usr/bin/apt-get', '/usr/bin/apt-cache']);
const SOURCE_FILE = '/etc/apt/sources.list.d/swir-debian.sources';
const STATE_FILE = '/var/lib/swir/image/base-build-state.json';

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'SystemBaseRootfsVerificationError';
  error.code = code;
  throw error;
}
function assert(condition, code, message) { if (!condition) fail(code, message); }
function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function inside(root, imagePath) {
  assert(typeof imagePath === 'string' && imagePath.startsWith('/') && path.posix.normalize(imagePath) === imagePath, 'INVALID_IMAGE_PATH', `invalid image path: ${imagePath}`);
  const target = path.resolve(root, `.${imagePath}`);
  assert(target === root || target.startsWith(`${root}${path.sep}`), 'IMAGE_PATH_ESCAPE', `path escaped rootfs: ${imagePath}`);
  return target;
}
async function safeRoot(rootfs) {
  assert(typeof rootfs === 'string' && path.isAbsolute(rootfs), 'ROOTFS_PATH_REQUIRED', 'rootfs must be an absolute path');
  const root = path.resolve(rootfs);
  assert(root !== path.parse(root).root, 'REAL_ROOT_TARGET_FORBIDDEN', 'refusing to verify live filesystem root');
  const stat = await fsp.lstat(root).catch(error => fail('ROOTFS_UNAVAILABLE', `rootfs unavailable: ${root}`, error));
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'ROOTFS_INVALID', 'rootfs must be a real non-symlink directory');
  assert(await fsp.realpath(root) === root, 'ROOTFS_SYMLINKED', 'rootfs must resolve exactly to the requested directory');
  return root;
}
async function regular(root, imagePath, { executable = false, production = false } = {}) {
  const target = inside(root, imagePath);
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return { ok: false, reason: 'missing-or-not-regular' };
  if (await fsp.realpath(target) !== target) return { ok: false, reason: 'symlinked' };
  if (production && typeof stat.uid === 'number' && stat.uid !== 0) return { ok: false, reason: 'owner-not-root', uid: stat.uid };
  if ((stat.mode & 0o022) !== 0) return { ok: false, reason: 'group-or-world-writable', mode: stat.mode & 0o777 };
  if (executable && (stat.mode & 0o111) === 0) return { ok: false, reason: 'not-executable', mode: stat.mode & 0o777 };
  return { ok: true, mode: stat.mode & 0o777, uid: typeof stat.uid === 'number' ? stat.uid : null };
}
function parseDpkgStatus(text) {
  const installed = new Map();
  for (const stanza of String(text).split(/\n\s*\n/)) {
    const fields = new Map();
    for (const line of stanza.split('\n')) {
      const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
      if (match) fields.set(match[1], match[2].trim());
    }
    if (fields.get('Status') !== 'install ok installed') continue;
    const name = fields.get('Package');
    const version = fields.get('Version');
    if (name && version) installed.set(name, version);
  }
  return installed;
}

export async function verifyDebianTrixieRootfs({ rootfs, profilePath, production = false } = {}) {
  const root = await safeRoot(rootfs);
  assert(typeof profilePath === 'string' && path.isAbsolute(profilePath), 'PROFILE_PATH_REQUIRED', 'profilePath must be absolute');
  const profileStat = await fsp.lstat(profilePath).catch(error => fail('PROFILE_UNAVAILABLE', 'base profile is unavailable', error));
  assert(profileStat.isFile() && !profileStat.isSymbolicLink(), 'PROFILE_UNTRUSTED', 'base profile must be a regular non-symlink file');
  const profileBytes = await fsp.readFile(profilePath);
  const profile = JSON.parse(profileBytes.toString('utf8'));
  assert(profile.schema === 'swir.system-base-profile/0.1' && profile.id === 'debian-13-trixie', 'PROFILE_MISMATCH', 'unexpected base profile');

  const checks = [];
  const add = (id, passed, detail = null) => checks.push(Object.freeze({ id, required: true, passed: Boolean(passed), detail }));
  const debianVersion = await fsp.readFile(inside(root, '/etc/debian_version'), 'utf8').catch(() => '');
  add('debian-major-13', /^13(?:\.|\s|$)/.test(debianVersion.trim()), { value: debianVersion.trim() });

  let state = null;
  try { state = JSON.parse(await fsp.readFile(inside(root, STATE_FILE), 'utf8')); } catch {}
  add('base-state-schema', state?.schema === 'swir.system-base-build-state/0.1');
  add('base-state-profile', state?.profile === 'debian-13-trixie' && state?.suite === 'trixie' && state?.architecture === 'amd64');
  add('base-state-profile-digest', state?.profileSha256 === sha256(profileBytes));
  add('base-state-trust', state?.nativeAptSignatureVerification === true && state?.officialRepositoriesOnly === true);
  add('honest-boot-claims', state?.bootableImageClaim === false && state?.secureBootClaim === false && state?.hardwareQualificationClaim === false);
  add('package-set-digest-shape', typeof state?.packageSetSha256 === 'string' && /^[a-f0-9]{64}$/.test(state.packageSetSha256));

  const source = await fsp.readFile(inside(root, SOURCE_FILE), 'utf8').catch(() => '');
  add('apt-official-main', source.includes('URIs: https://deb.debian.org/debian') && source.includes('Suites: trixie trixie-updates'));
  add('apt-official-security', source.includes('URIs: https://security.debian.org/debian-security') && source.includes('Suites: trixie-security'));
  add('apt-keyring-binding', (source.match(/Signed-By: \/usr\/share\/keyrings\/debian-archive-keyring\.gpg/g) || []).length === 2);
  add('apt-no-insecure-source', !/\btrusted\s*=\s*yes\b|\[trusted=yes\]|http:\/\//i.test(source));
  add('legacy-sources-list-absent', !fs.existsSync(inside(root, '/etc/apt/sources.list')));

  const dpkgStatus = await fsp.readFile(inside(root, '/var/lib/dpkg/status'), 'utf8').catch(() => '');
  const installed = parseDpkgStatus(dpkgStatus);
  for (const packageName of REQUIRED_PACKAGES) add(`package:${packageName}`, installed.has(packageName), { version: installed.get(packageName) ?? null });

  for (const binary of REQUIRED_BINARIES) {
    const evidence = await regular(root, binary, { executable: true, production });
    add(`binary:${binary}`, evidence.ok, evidence);
  }

  const bootEntries = await fsp.readdir(inside(root, '/boot')).catch(() => []);
  add('kernel-image-present', bootEntries.some(name => /^vmlinuz-/.test(name)), { entries: bootEntries.filter(name => /^vmlinuz-/.test(name)).slice(0, 8) });

  const blockers = checks.filter(check => check.required && !check.passed).map(check => check.id);
  return Object.freeze({
    schema: 'swir.system-base-rootfs-verification/0.1',
    profile: 'debian-13-trixie',
    production,
    ready: blockers.length === 0,
    bootableImageClaim: false,
    secureBootClaim: false,
    hardwareQualificationClaim: false,
    checks: Object.freeze(checks),
    blockers: Object.freeze(blockers)
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootfsIndex = process.argv.indexOf('--rootfs');
  const profileIndex = process.argv.indexOf('--profile');
  if (rootfsIndex < 0 || profileIndex < 0 || !process.argv[rootfsIndex + 1] || !process.argv[profileIndex + 1]) {
    console.error('Usage: verify-debian-trixie-rootfs.mjs --rootfs <absolute-path> --profile <absolute-path> [--production]');
    process.exit(64);
  }
  try {
    const report = await verifyDebianTrixieRootfs({
      rootfs: path.resolve(process.argv[rootfsIndex + 1]),
      profilePath: path.resolve(process.argv[profileIndex + 1]),
      production: process.argv.includes('--production')
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.ready) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error?.code || 'ROOTFS_VERIFY_FAILED'}: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
