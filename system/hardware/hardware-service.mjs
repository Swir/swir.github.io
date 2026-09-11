import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SOURCE_CLASSES = new Set([
  'kernel-in-tree',
  'linux-firmware',
  'distribution-repository',
  'fwupd-lvfs',
  'vendor-official-repository'
]);

const PACKAGE_MANAGER_PROBES = [
  ['apt', 'usr/bin/apt'],
  ['dnf', 'usr/bin/dnf'],
  ['rpm-ostree', 'usr/bin/rpm-ostree'],
  ['pacman', 'usr/bin/pacman'],
  ['zypper', 'usr/bin/zypper']
];

const REPOSITORY_CONFIG_PROBES = [
  ['apt', 'etc/apt/sources.list'],
  ['apt', 'etc/apt/sources.list.d'],
  ['dnf', 'etc/yum.repos.d'],
  ['zypper', 'etc/zypp/repos.d'],
  ['pacman', 'etc/pacman.conf']
];

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); }
  catch { return null; }
}

function safeRealpath(file) {
  try { return fs.realpathSync(file); }
  catch { return null; }
}

function exists(file) {
  try { return fs.existsSync(file); }
  catch { return false; }
}

function normalizeHex(value, width = 4) {
  if (value == null) return null;
  const clean = String(value).trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(clean)) return null;
  return clean.padStart(width, '0');
}

function basenameOrNull(target) {
  return target ? path.basename(target) : null;
}

function listDirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function parseOsRelease(raw) {
  const values = {};
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value.replace(/\\([\\"'$`])/g, '$1');
  }
  return values;
}

function distributionFamily(release) {
  const candidates = [release.ID, ...(release.ID_LIKE || '').split(/\s+/)].filter(Boolean);
  const map = new Map([
    ['ubuntu', 'debian'], ['debian', 'debian'], ['linuxmint', 'debian'],
    ['fedora', 'fedora'], ['rhel', 'fedora'], ['centos', 'fedora'],
    ['arch', 'arch'], ['manjaro', 'arch'],
    ['opensuse', 'suse'], ['opensuse-leap', 'suse'], ['sles', 'suse']
  ]);
  for (const candidate of candidates) {
    const family = map.get(candidate.toLowerCase());
    if (family) return family;
  }
  return 'unknown';
}

export function detectLinuxHostEnvironment({ root = '/' } = {}) {
  const release = parseOsRelease(safeRead(path.join(root, 'etc', 'os-release')) || safeRead(path.join(root, 'usr', 'lib', 'os-release')) || '');
  const packageManagers = PACKAGE_MANAGER_PROBES
    .filter(([, relative]) => exists(path.join(root, relative)))
    .map(([name]) => name);
  const repositoryConfig = REPOSITORY_CONFIG_PROBES
    .filter(([, relative]) => exists(path.join(root, relative)))
    .map(([manager, relative]) => ({ manager, path: `/${relative.replace(/\\/g, '/')}` }));
  const fwupdRelative = ['usr/bin/fwupdmgr', 'usr/libexec/fwupd/fwupd', 'usr/lib/fwupd/fwupd']
    .find(relative => exists(path.join(root, relative)));

  return {
    distribution: {
      id: release.ID || 'unknown',
      versionId: release.VERSION_ID || null,
      prettyName: release.PRETTY_NAME || release.NAME || release.ID || 'Unknown Linux',
      family: distributionFamily(release)
    },
    capabilities: {
      fwupd: {
        available: Boolean(fwupdRelative),
        executable: fwupdRelative ? `/${fwupdRelative}` : null,
        lvfsMetadataPresent: exists(path.join(root, 'var', 'lib', 'fwupd', 'remotes.d', 'lvfs'))
          || exists(path.join(root, 'var', 'lib', 'fwupd', 'metadata'))
      },
      packageManagers,
      repositoryConfig
    }
  };
}

function pciIds(devicePath) {
  return {
    vendor: normalizeHex(safeRead(path.join(devicePath, 'vendor'))),
    device: normalizeHex(safeRead(path.join(devicePath, 'device'))),
    subsystemVendor: normalizeHex(safeRead(path.join(devicePath, 'subsystem_vendor'))),
    subsystemDevice: normalizeHex(safeRead(path.join(devicePath, 'subsystem_device')))
  };
}

function usbIds(devicePath) {
  return {
    vendor: normalizeHex(safeRead(path.join(devicePath, 'idVendor'))),
    product: normalizeHex(safeRead(path.join(devicePath, 'idProduct')))
  };
}

function cleanIds(ids) {
  return Object.fromEntries(Object.entries(ids).filter(([, value]) => value));
}

function readDriver(devicePath) {
  const target = safeRealpath(path.join(devicePath, 'driver'));
  const modalias = safeRead(path.join(devicePath, 'modalias'));
  if (target) return { status: 'loaded', module: basenameOrNull(target), modalias };
  return { status: modalias ? 'unbound' : 'unknown', module: null, modalias };
}

function makeDevice(bus, devicePath, ids) {
  return {
    key: `${bus}:${path.basename(devicePath)}`,
    bus,
    sysfsPath: devicePath,
    ids: cleanIds(ids),
    driver: readDriver(devicePath),
    catalog: { matched: false, entryIds: [], recommendedSources: [] }
  };
}

export function scanLinuxSysfs({ sysRoot = '/sys' } = {}) {
  const devices = [];
  for (const devicePath of listDirs(path.join(sysRoot, 'bus', 'pci', 'devices'))) {
    const ids = cleanIds(pciIds(devicePath));
    if (ids.vendor && ids.device) devices.push(makeDevice('pci', devicePath, ids));
  }
  for (const devicePath of listDirs(path.join(sysRoot, 'bus', 'usb', 'devices'))) {
    const ids = cleanIds(usbIds(devicePath));
    if (ids.vendor && ids.product) devices.push(makeDevice('usb', devicePath, ids));
  }
  return devices.sort((a, b) => a.key.localeCompare(b.key));
}

function pciTokens(device) {
  const { vendor, device: product, subsystemVendor, subsystemDevice } = device.ids;
  const out = [];
  if (vendor && product) out.push(`pci:${vendor}:${product}`);
  if (vendor && product && subsystemVendor && subsystemDevice) {
    out.push(`pci:${vendor}:${product}:${subsystemVendor}:${subsystemDevice}`);
  }
  return out;
}

function usbTokens(device) {
  const { vendor, product } = device.ids;
  return vendor && product ? [`usb:${vendor}:${product}`] : [];
}

export function deviceMatchTokens(device) {
  if (device.bus === 'pci') return pciTokens(device);
  if (device.bus === 'usb') return usbTokens(device);
  return [`platform:${device.key.replace(/^platform:/, '')}`];
}

function wildcardMatch(pattern, value) {
  const escaped = pattern
    .toLowerCase()
    .replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

function validateSources(sources) {
  return (sources || []).filter(source =>
    source && SOURCE_CLASSES.has(source.class) && typeof source.ref === 'string' && source.ref.trim().length > 0
  );
}

export function applyHardwareCatalog(devices, catalog) {
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  return devices.map(device => {
    const tokens = deviceMatchTokens(device);
    const matches = entries.filter(entry => {
      if (!entry?.match || entry.match.bus !== device.bus || !Array.isArray(entry.match.ids)) return false;
      return entry.match.ids.some(pattern => tokens.some(token => wildcardMatch(pattern, token)));
    });
    const sourceMap = new Map();
    for (const entry of matches) {
      for (const source of validateSources(entry.sources)) {
        const key = `${source.class}\u0000${source.ref}\u0000${source.repositoryId || ''}`;
        if (!sourceMap.has(key)) sourceMap.set(key, source);
      }
    }
    return {
      ...device,
      catalog: {
        matched: matches.length > 0,
        entryIds: [...new Set(matches.map(entry => entry.id).filter(Boolean))].sort(),
        recommendedSources: [...sourceMap.values()]
      }
    };
  });
}

export function createHardwareSnapshot({
  devices,
  catalog,
  platform = os.platform(),
  arch = os.arch(),
  kernel = os.release(),
  environment = null,
  now = new Date()
}) {
  const hostEnvironment = environment || {
    distribution: { id: 'unknown', versionId: null, prettyName: platform, family: 'unknown' },
    capabilities: { fwupd: { available: false, executable: null, lvfsMetadataPresent: false }, packageManagers: [], repositoryConfig: [] }
  };
  return {
    schema: 'swir.hardware-snapshot/0.2',
    generatedAt: now.toISOString(),
    host: {
      platform,
      arch,
      kernel,
      readOnly: true,
      distribution: hostEnvironment.distribution,
      capabilities: hostEnvironment.capabilities
    },
    devices: applyHardwareCatalog(devices, catalog)
  };
}

export function collectHardwareSnapshot({ catalog = { entries: [] }, sysRoot = '/sys', hostRoot = '/', now = new Date() } = {}) {
  if (os.platform() !== 'linux') {
    return createHardwareSnapshot({ devices: [], catalog, platform: os.platform(), arch: os.arch(), kernel: os.release(), now });
  }
  return createHardwareSnapshot({
    devices: scanLinuxSysfs({ sysRoot }),
    catalog,
    environment: detectLinuxHostEnvironment({ root: hostRoot }),
    now
  });
}

export function loadCatalog(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed?.schema !== 'swir.hardware-catalog/0.1' || !Array.isArray(parsed.entries)) {
    throw new Error('Unsupported or invalid SWIR Hardware Catalog');
  }
  return parsed;
}

export function assertReadOnlyContract(snapshot) {
  if (snapshot?.schema !== 'swir.hardware-snapshot/0.2') throw new Error('Hardware snapshot schema mismatch');
  if (snapshot?.host?.readOnly !== true) throw new Error('Hardware Service must stay read-only');
  if (!snapshot?.host?.distribution || !snapshot?.host?.capabilities) throw new Error('Hardware snapshot host diagnostics missing');
  for (const device of snapshot.devices || []) {
    for (const source of device.catalog?.recommendedSources || []) {
      if (!SOURCE_CLASSES.has(source.class)) throw new Error(`Untrusted driver source class: ${source.class}`);
    }
  }
  return true;
}
