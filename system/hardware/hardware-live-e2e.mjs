import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertReadOnlyContract,
  collectHardwareSnapshot,
  deviceMatchTokens,
  loadCatalog
} from './hardware-service.mjs';
import { assertSafeDriverPlan, resolveDriverPlan } from './driver-resolver.mjs';
import { assertSafeDriverCenterReport, createDriverCenterReport } from './driver-center-service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.join(here, 'hardware-catalog.json');
const trustedSourcesPath = path.join(here, '..', 'contracts', 'trusted-sources.json');
const HEX4 = /^[0-9a-f]{4}$/;
const TRUSTED_SOURCE_CLASSES = new Set([
  'kernel-in-tree',
  'linux-firmware',
  'distribution-repository',
  'fwupd-lvfs',
  'vendor-official-repository'
]);

function fail(code, message) {
  const error = new Error(message);
  error.name = 'HardwareLiveE2EError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function parseArgs(argv) {
  const out = { output: null, compact: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--compact') out.compact = true;
    else if (arg === '--output') {
      out.output = argv[++index] || null;
      assert(out.output, 'OUTPUT_PATH_REQUIRED', '--output requires a path');
    } else {
      fail('UNKNOWN_ARGUMENT', `Unsupported argument: ${arg}`);
    }
  }
  return out;
}

function safeRealpath(target) {
  try { return fs.realpathSync(target); }
  catch { return null; }
}

function assertDevice(device) {
  assert(device && (device.bus === 'pci' || device.bus === 'usb'), 'BUS_INVALID', `Unsupported live bus for ${device?.key || '(unknown)'}`);
  assert(typeof device.key === 'string' && device.key.startsWith(`${device.bus}:`), 'DEVICE_KEY_INVALID', `Invalid key for ${device?.key || '(unknown)'}`);
  assert(typeof device.sysfsPath === 'string', 'SYSFS_PATH_MISSING', `Missing sysfs path for ${device.key}`);
  const normalized = path.resolve(device.sysfsPath);
  const expectedPrefix = `/sys/bus/${device.bus}/devices/`;
  assert(normalized.startsWith(expectedPrefix), 'SYSFS_PATH_OUTSIDE_BUS', `Device ${device.key} is outside the expected ${device.bus} sysfs bus`);
  const real = safeRealpath(normalized);
  assert(real && (real === '/sys/devices' || real.startsWith('/sys/devices/')), 'SYSFS_REALPATH_UNTRUSTED', `Device ${device.key} does not resolve inside kernel sysfs devices`);

  if (device.bus === 'pci') {
    assert(HEX4.test(device.ids?.vendor || ''), 'PCI_VENDOR_INVALID', `Invalid PCI vendor ID for ${device.key}`);
    assert(HEX4.test(device.ids?.device || ''), 'PCI_DEVICE_INVALID', `Invalid PCI device ID for ${device.key}`);
  } else {
    assert(HEX4.test(device.ids?.vendor || ''), 'USB_VENDOR_INVALID', `Invalid USB vendor ID for ${device.key}`);
    assert(HEX4.test(device.ids?.product || ''), 'USB_PRODUCT_INVALID', `Invalid USB product ID for ${device.key}`);
  }

  const tokens = deviceMatchTokens(device);
  assert(Array.isArray(tokens) && tokens.length > 0, 'MATCH_TOKEN_MISSING', `No match token for ${device.key}`);
  assert(tokens.every(token => token.startsWith(`${device.bus}:`)), 'MATCH_TOKEN_INVALID', `Invalid match token for ${device.key}`);

  if (device.driver?.status === 'loaded') {
    assert(typeof device.driver.module === 'string' && device.driver.module.length > 0, 'LOADED_MODULE_MISSING', `Loaded driver has no module for ${device.key}`);
  }
  for (const source of device.catalog?.recommendedSources || []) {
    assert(TRUSTED_SOURCE_CLASSES.has(source?.class), 'UNTRUSTED_SOURCE_CLASS', `Untrusted source class for ${device.key}`);
    assert(typeof source?.ref === 'string' && source.ref.length > 0, 'SOURCE_REF_INVALID', `Empty source reference for ${device.key}`);
    assert(!/^https?:\/\//i.test(source.ref), 'ARBITRARY_SOURCE_URL', `Direct driver URL exposed for ${device.key}`);
  }
}

function buildEvidence(snapshot, plan, report) {
  const devices = snapshot.devices || [];
  const pci = devices.filter(device => device.bus === 'pci');
  const usb = devices.filter(device => device.bus === 'usb');
  const loadedDrivers = devices.filter(device => device.driver?.status === 'loaded');
  const unbound = devices.filter(device => device.driver?.status === 'unbound');
  const matched = devices.filter(device => device.catalog?.matched === true);

  assert(os.platform() === 'linux', 'LINUX_REQUIRED', 'Live Hardware Service E2E requires Linux');
  assert(snapshot.host?.platform === 'linux', 'SNAPSHOT_PLATFORM_INVALID', 'Hardware snapshot must report Linux');
  assert(snapshot.host?.readOnly === true, 'READ_ONLY_REQUIRED', 'Live Hardware Service must stay read-only');
  assert(devices.length > 0, 'NO_LIVE_DEVICES', 'Kernel sysfs exposed no PCI/USB devices');
  assert(pci.length > 0, 'NO_LIVE_PCI_DEVICES', 'Kernel sysfs exposed no PCI devices');
  assert(loadedDrivers.length > 0, 'NO_BOUND_KERNEL_DRIVERS', 'No live PCI/USB device has a bound kernel driver');
  assert(new Set(devices.map(device => device.key)).size === devices.length, 'DUPLICATE_DEVICE_KEY', 'Hardware inventory contains duplicate device keys');
  devices.forEach(assertDevice);

  assert(plan?.readOnly === true && plan?.autoExecutable === false, 'DRIVER_PLAN_MUTABLE', 'Driver resolver must remain preview-only');
  assert(report?.readOnly === true && report?.autoMutation === false, 'DRIVER_CENTER_MUTABLE', 'Driver Center must remain diagnostics-only');
  assert(report?.summary?.violations === 0, 'DRIVER_CENTER_POLICY_VIOLATION', 'Driver Center reported a trust-policy violation');

  return {
    schema: 'swir.hardware-live-e2e/0.1',
    generatedAt: new Date().toISOString(),
    platform: snapshot.host.platform,
    architecture: snapshot.host.arch,
    kernelRelease: snapshot.host.kernel,
    distribution: snapshot.host.distribution,
    inventoryProvider: 'linux-sysfs',
    sysfsRoot: '/sys',
    readOnly: true,
    devices: {
      total: devices.length,
      pci: pci.length,
      usb: usb.length,
      loadedDrivers: loadedDrivers.length,
      unbound: unbound.length,
      catalogMatched: matched.length
    },
    packageManagers: snapshot.host.capabilities?.packageManagers || [],
    driverPlanOperations: plan.summary?.operations || 0,
    driverCenterViolations: report.summary?.violations || 0,
    unknownHardwareAutoDownload: report.policy?.unknownHardwareMayAutoDownload === true,
    arbitraryDriverUrls: report.policy?.arbitraryDriverUrls === true,
    windowsKernelDriversAsLinuxDrivers: report.policy?.windowsKernelDriversAsLinuxDrivers === true,
    hardwareQualificationClaim: false,
    passed: true
  };
}

export function runHardwareLiveE2E() {
  const catalog = loadCatalog(catalogPath);
  const trustedSources = JSON.parse(fs.readFileSync(trustedSourcesPath, 'utf8'));
  assert(trustedSources?.schema === 'swir.trusted-sources/0.1', 'TRUST_POLICY_SCHEMA_INVALID', 'Trusted-source policy schema mismatch');
  const snapshot = collectHardwareSnapshot({ catalog });
  assertReadOnlyContract(snapshot);
  const plan = resolveDriverPlan(snapshot, catalog);
  assertSafeDriverPlan(plan);
  const report = createDriverCenterReport(snapshot, plan, trustedSources);
  assertSafeDriverCenterReport(report);
  return buildEvidence(snapshot, plan, report);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const evidence = runHardwareLiveE2E();
    const json = JSON.stringify(evidence, null, args.compact ? 0 : 2) + '\n';
    if (args.output) fs.writeFileSync(args.output, json, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(json);
  } catch (error) {
    process.stderr.write(`${error?.code || error?.name || 'ERROR'}: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
