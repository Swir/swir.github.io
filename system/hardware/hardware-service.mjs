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

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); }
  catch { return null; }
}

function safeRealpath(file) {
  try { return fs.realpathSync(file); }
  catch { return null; }
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

function pciIds(devicePath) {
  return {
    vendor: normalizeHex(safeRead(path.join(devicePath, 'vendor'))),
    device: normalizeHex(safeRead(path.join(devicePath, 'device'))),
    subsystemVendor: normalizeHex(safeRead(path.join(devicePath, 'subsystem_vendor'))),
    subsystemDevice: normalizeHex(safeRead(path.join(devicePath, 'subsystem_device')),
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
  if (target) return { status: 'loaded', module: basenameOrNull(target) };
  const modalias = safeRead(path.join(devicePath, 'modalias'));
  return { status: modalias ? 'unbound' : 'unknown', module: null };
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
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
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

export function createHardwareSnapshot({ devices, catalog, platform = os.platform(), arch = os.arch(), kernel = os.release(), now = new Date() }) {
  return {
    schema: 'swir.hardware-snapshot/0.1',
    generatedAt: now.toISOString(),
    host: { platform, arch, kernel, readOnly: true },
    devices: applyHardwareCatalog(devices, catalog)
  };
}

export function collectHardwareSnapshot({ catalog = { entries: [] }, sysRoot = '/sys', now = new Date() } = {}) {
  if (os.platform() !== 'linux') {
    return createHardwareSnapshot({ devices: [], catalog, platform: os.platform(), arch: os.arch(), kernel: os.release(), now });
  }
  return createHardwareSnapshot({ devices: scanLinuxSysfs({ sysRoot }), catalog, now });
}

export function loadCatalog(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed?.schema !== 'swir.hardware-catalog/0.1' || !Array.isArray(parsed.entries)) {
    throw new Error('Unsupported or invalid SWIR Hardware Catalog');
  }
  return parsed;
}

export function assertReadOnlyContract(snapshot) {
  if (snapshot?.schema !== 'swir.hardware-snapshot/0.1') throw new Error('Hardware snapshot schema mismatch');
  if (snapshot?.host?.readOnly !== true) throw new Error('Hardware Service must stay read-only');
  for (const device of snapshot.devices || []) {
    for (const source of device.catalog?.recommendedSources || []) {
      if (!SOURCE_CLASSES.has(source.class)) throw new Error(`Untrusted driver source class: ${source.class}`);
    }
  }
  return true;
}
