import fs from 'node:fs';
import os from 'node:os';

const fsp = fs.promises;
const TRUST_ROOT = '/var/lib/swir/security/catalog-trust';
const BINARY_GROUPS = Object.freeze({
  packageManager: Object.freeze([
    ['/usr/bin/apt-get', 'apt'],
    ['/usr/bin/dnf', 'dnf'],
    ['/usr/bin/rpm-ostree', 'rpm-ostree'],
    ['/usr/bin/pacman', 'pacman'],
    ['/usr/bin/zypper', 'zypper']
  ]),
  serviceManager: Object.freeze([['/usr/bin/systemctl', 'systemd'], ['/bin/systemctl', 'systemd']]),
  sessionManager: Object.freeze([['/usr/bin/loginctl', 'systemd-logind']]),
  polkit: Object.freeze([['/usr/bin/pkcheck', 'polkit']]),
  networkManager: Object.freeze([['/usr/bin/nmcli', 'NetworkManager']]),
  fwupd: Object.freeze([['/usr/bin/fwupdmgr', 'fwupd']]),
  flatpak: Object.freeze([['/usr/bin/flatpak', 'flatpak']]),
  wine: Object.freeze([['/usr/bin/wine', 'wine'], ['/usr/bin/wine64', 'wine']])
});

function safeText(value, max = 256) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function parseOsRelease(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
    out[match[1]] = safeText(value, 512);
  }
  return out;
}

async function inspectPath(target, { requireDirectory = false, requireExecutable = false, expectedUid = 0 } = {}) {
  try {
    const lstat = await fsp.lstat(target);
    const real = await fsp.realpath(target);
    const stat = await fsp.stat(real);
    const typeOk = requireDirectory ? stat.isDirectory() : stat.isFile();
    const executableOk = !requireExecutable || (stat.mode & 0o111) !== 0;
    const ownerOk = expectedUid === null || typeof stat.uid !== 'number' || stat.uid === expectedUid;
    const writableByGroupOrWorld = (stat.mode & 0o022) !== 0;
    const safeRoot = real === target || (!requireDirectory && real.startsWith('/usr/'));
    return {
      path: target, realPath: real, available: typeOk, symlink: lstat.isSymbolicLink(),
      ownerUid: typeof stat.uid === 'number' ? stat.uid : null,
      ownerOk, writableByGroupOrWorld, executable: requireExecutable ? executableOk : null,
      trusted: typeOk && executableOk && ownerOk && !writableByGroupOrWorld && safeRoot
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: target, realPath: null, available: false, trusted: false, reason: 'missing' };
    return { path: target, realPath: null, available: false, trusted: false, reason: safeText(error?.code || 'probe-error', 64) };
  }
}

async function firstTrustedBinary(candidates) {
  const observed = [];
  for (const [binary, provider] of candidates) {
    const probe = await inspectPath(binary, { requireExecutable: true, expectedUid: 0 });
    observed.push({ ...probe, provider });
    if (probe.available && probe.trusted) return { selected: { ...probe, provider }, observed };
  }
  return { selected: null, observed };
}

async function probeCatalogStateRoot(target = TRUST_ROOT) {
  const probe = await inspectPath(target, { requireDirectory: true, expectedUid: 0 });
  if (!probe.available) return { ...probe, modeOk: false };
  let modeOk = false;
  try {
    const stat = await fsp.stat(target);
    modeOk = (stat.mode & 0o077) === 0;
  } catch {}
  return { ...probe, modeOk, trusted: probe.trusted && !probe.symlink && modeOk && probe.realPath === target };
}

export async function collectSystemImageHostEvidence({ catalogStateRoot = TRUST_ROOT } = {}) {
  let osReleaseText = '';
  try { osReleaseText = await fsp.readFile('/etc/os-release', 'utf8'); } catch {}
  const release = parseOsRelease(osReleaseText);
  const proc = await inspectPath('/proc', { requireDirectory: true, expectedUid: null });
  const sys = await inspectPath('/sys', { requireDirectory: true, expectedUid: null });
  const binaries = {};
  for (const [key, candidates] of Object.entries(BINARY_GROUPS)) binaries[key] = await firstTrustedBinary(candidates);
  const catalogState = await probeCatalogStateRoot(catalogStateRoot);
  return {
    schema: 'swir.system-image-host-evidence/0.1',
    readOnly: true,
    collectedAt: new Date().toISOString(),
    platform: os.platform(),
    architecture: os.arch(),
    kernelRelease: safeText(os.release(), 256),
    distribution: {
      id: safeText(release.ID, 128) || null,
      versionId: safeText(release.VERSION_ID, 128) || null,
      prettyName: safeText(release.PRETTY_NAME, 256) || null
    },
    filesystems: { proc, sys },
    catalogState,
    binaries
  };
}

function gate(id, passed, detail, required = true) {
  return { id, required, passed: Boolean(passed), detail: safeText(detail, 512) };
}

export function evaluateSystemImageReadiness(evidence) {
  if (evidence?.schema !== 'swir.system-image-host-evidence/0.1' || evidence?.readOnly !== true) {
    throw new Error('System image readiness requires read-only host evidence');
  }
  const selected = key => evidence?.binaries?.[key]?.selected || null;
  const gates = [
    gate('linux-host', evidence.platform === 'linux', `platform=${evidence.platform}`),
    gate('distribution-identity', Boolean(evidence?.distribution?.id && evidence?.distribution?.versionId), `${evidence?.distribution?.id || 'unknown'} ${evidence?.distribution?.versionId || ''}`),
    gate('kernel-visible', Boolean(evidence.kernelRelease), `kernel=${evidence.kernelRelease || 'unknown'}`),
    gate('procfs', evidence?.filesystems?.proc?.available === true, '/proc available'),
    gate('sysfs', evidence?.filesystems?.sys?.available === true, '/sys available'),
    gate('trusted-package-manager', Boolean(selected('packageManager')?.trusted), selected('packageManager')?.provider || 'none'),
    gate('systemd-service-manager', Boolean(selected('serviceManager')?.trusted), selected('serviceManager')?.realPath || 'missing'),
    gate('systemd-session-manager', Boolean(selected('sessionManager')?.trusted), selected('sessionManager')?.realPath || 'missing'),
    gate('polkit-broker', Boolean(selected('polkit')?.trusted), selected('polkit')?.realPath || 'missing'),
    gate('networkmanager-client', Boolean(selected('networkManager')?.trusted), selected('networkManager')?.realPath || 'missing'),
    gate('catalog-trust-state-root', evidence?.catalogState?.trusted === true, evidence?.catalogState?.path || TRUST_ROOT),
    gate('fwupd-discovery', Boolean(selected('fwupd')?.trusted), selected('fwupd')?.realPath || 'optional/missing', false),
    gate('flatpak-runtime', Boolean(selected('flatpak')?.trusted), selected('flatpak')?.realPath || 'optional/missing', false),
    gate('wine-runtime', Boolean(selected('wine')?.trusted), selected('wine')?.realPath || 'optional/missing', false)
  ];
  const required = gates.filter(item => item.required);
  const blockers = required.filter(item => !item.passed).map(item => item.id);
  const baseGateIds = new Set(['linux-host', 'distribution-identity', 'kernel-visible', 'procfs', 'sysfs', 'trusted-package-manager', 'systemd-service-manager']);
  const baseReady = required.filter(item => baseGateIds.has(item.id)).every(item => item.passed);
  const securityReady = ['polkit-broker', 'catalog-trust-state-root'].every(id => gates.find(item => item.id === id)?.passed === true);
  const sessionReady = gates.find(item => item.id === 'systemd-session-manager')?.passed === true;
  const networkReady = gates.find(item => item.id === 'networkmanager-client')?.passed === true;
  return Object.freeze({
    schema: 'swir.system-image-readiness/0.1',
    readOnly: true,
    generatedAt: new Date().toISOString(),
    distribution: evidence.distribution,
    architecture: evidence.architecture,
    kernelRelease: evidence.kernelRelease,
    gates,
    summary: {
      requiredPassed: required.filter(item => item.passed).length,
      requiredTotal: required.length,
      optionalPassed: gates.filter(item => !item.required && item.passed).length,
      optionalTotal: gates.filter(item => !item.required).length,
      baseReady,
      securityReady,
      sessionReady,
      networkReady,
      systemImageReadyForE2E: blockers.length === 0,
      blockers
    }
  });
}

export async function probeSystemImageReadiness(options = {}) {
  return evaluateSystemImageReadiness(await collectSystemImageHostEvidence(options));
}

export const SystemImageReadinessPolicy = Object.freeze({
  schema: 'swir.system-image-readiness/0.1',
  readOnly: true,
  productionCatalogStateRoot: TRUST_ROOT,
  requiredCore: ['linux-host', 'distribution-identity', 'kernel-visible', 'procfs', 'sysfs', 'trusted-package-manager', 'systemd-service-manager', 'systemd-session-manager', 'polkit-broker', 'networkmanager-client', 'catalog-trust-state-root'],
  optionalProviders: ['fwupd-discovery', 'flatpak-runtime', 'wine-runtime'],
  bootableImageClaim: false,
  mutationPerformed: false
});
