import assert from 'node:assert/strict';
import { resolveDriverPlan } from './driver-resolver.mjs';
import { assertSafeDriverCenterReport, createDriverCenterReport } from './driver-center-service.mjs';

const trustedSources = {
  schema: 'swir.trusted-sources/0.1',
  driverSourceClasses: ['kernel-in-tree', 'linux-firmware', 'distribution-repository', 'fwupd-lvfs', 'vendor-official-repository'],
  forbiddenAutomaticDriverArtifacts: ['.exe', '.msi', '.sys', '.bat', '.cmd'],
  policy: {
    arbitraryDriverUrls: false,
    windowsKernelDriversAsLinuxDrivers: false,
    signatureVerificationRequiredForRepositories: true,
    privilegedMutationRequiresPlan: true,
    privilegedMutationRequiresJournal: true,
    unknownHardwareMayAutoDownload: false
  }
};

const catalog = {
  schema: 'swir.hardware-catalog/0.1',
  version: 'selftest',
  entries: [
    {
      id: 'test-ethernet',
      match: { bus: 'pci', ids: ['pci:8086:100e'] },
      support: { kernelModules: ['e1000'], packages: [] },
      sources: [{ class: 'kernel-in-tree', ref: 'linux-kernel/e1000', rollback: true }]
    },
    {
      id: 'test-wifi',
      match: { bus: 'pci', ids: ['pci:168c:003e'] },
      support: { kernelModules: ['ath10k_pci'], firmware: ['ath10k/QCA6174'], packages: ['linux-firmware'] },
      sources: [
        { class: 'kernel-in-tree', ref: 'linux-kernel/ath10k_pci', rollback: true },
        { class: 'linux-firmware', ref: 'linux-firmware/ath10k', rollback: true },
        { class: 'distribution-repository', ref: 'linux-firmware', rollback: true }
      ]
    }
  ]
};

const snapshot = {
  schema: 'swir.hardware-snapshot/0.2',
  generatedAt: '2026-09-14T00:00:00.000Z',
  host: {
    platform: 'linux', arch: 'x64', kernel: 'selftest', readOnly: true,
    distribution: { id: 'ubuntu', versionId: '24.04', prettyName: 'Ubuntu 24.04', family: 'debian' },
    capabilities: {
      fwupd: { available: true, executable: '/usr/bin/fwupdmgr', lvfsMetadataPresent: true },
      packageManagers: ['apt'],
      repositoryConfig: [{ manager: 'apt', path: '/etc/apt/sources.list.d' }]
    }
  },
  devices: [
    {
      key: 'pci:0000:00:03.0', bus: 'pci', ids: { vendor: '8086', device: '100e' },
      driver: { status: 'loaded', module: 'e1000', modalias: 'pci:v00008086d0000100E' },
      catalog: { matched: true, entryIds: ['test-ethernet'], recommendedSources: catalog.entries[0].sources }
    },
    {
      key: 'pci:0000:01:00.0', bus: 'pci', ids: { vendor: '168c', device: '003e' },
      driver: { status: 'unbound', module: null, modalias: 'pci:v0000168Cd0000003E' },
      catalog: { matched: true, entryIds: ['test-wifi'], recommendedSources: catalog.entries[1].sources }
    },
    {
      key: 'usb:1-3', bus: 'usb', ids: { vendor: 'ffff', product: '0001' },
      driver: { status: 'unknown', module: null, modalias: null },
      catalog: { matched: false, entryIds: [], recommendedSources: [] }
    }
  ]
};

const plan = resolveDriverPlan(snapshot, catalog, { now: new Date('2026-09-14T00:00:00Z') });
const report = createDriverCenterReport(snapshot, plan, trustedSources, { now: new Date('2026-09-14T00:00:01Z') });
assertSafeDriverCenterReport(report);
assert.equal(report.summary.devices, 3);
assert.equal(report.summary.healthy, 1);
assert.equal(report.summary.attention, 1);
assert.equal(report.summary.unknown, 1);
assert.equal(report.summary.unbound, 1);
assert.equal(report.summary.violations, 0);
assert.equal(report.autoMutation, false);
assert.equal(report.devices.find(device => device.key === 'usb:1-3')?.status, 'unknown');
assert.match(report.devices.find(device => device.key === 'usb:1-3')?.reasons.join(' ') || '', /do not auto-download/i);
assert.ok(report.operations.length >= 3, 'expected review operations for unbound matched Wi-Fi device');

const maliciousCatalog = {
  ...catalog,
  entries: [{
    id: 'unsafe-device',
    match: { bus: 'usb', ids: ['usb:ffff:0001'] },
    support: { packages: ['bad-driver'] },
    sources: [{ class: 'vendor-official-repository', ref: 'https://example.invalid/driver.exe', rollback: false }]
  }]
};
const maliciousSnapshot = structuredClone(snapshot);
maliciousSnapshot.devices[2].catalog = {
  matched: true,
  entryIds: ['unsafe-device'],
  recommendedSources: maliciousCatalog.entries[0].sources
};
const maliciousPlan = resolveDriverPlan(maliciousSnapshot, maliciousCatalog, { now: new Date('2026-09-14T00:00:02Z') });
const unsafe = createDriverCenterReport(maliciousSnapshot, maliciousPlan, trustedSources, { now: new Date('2026-09-14T00:00:03Z') });
assert.ok(unsafe.violations.some(item => item.code === 'ARBITRARY_DRIVER_URL'));
assert.ok(unsafe.violations.some(item => item.code === 'FORBIDDEN_DRIVER_ARTIFACT'));
assert.ok(unsafe.violations.some(item => item.code === 'VENDOR_REPOSITORY_ID_REQUIRED'));
assert.throws(() => assertSafeDriverCenterReport(unsafe), /Unsafe Driver Center report/);

const weakenedPolicy = structuredClone(trustedSources);
weakenedPolicy.policy.unknownHardwareMayAutoDownload = true;
const weakened = createDriverCenterReport(snapshot, plan, weakenedPolicy);
assert.ok(weakened.violations.some(item => item.code === 'UNKNOWN_HARDWARE_AUTO_DOWNLOAD_ENABLED'));
assert.throws(() => assertSafeDriverCenterReport(weakened), /Unknown hardware auto-download|Unsafe Driver Center report/);

console.log('SWIR Driver Center diagnostics self-tests passed.');
