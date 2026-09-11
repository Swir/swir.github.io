import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  applyHardwareCatalog,
  assertReadOnlyContract,
  createHardwareSnapshot,
  detectLinuxHostEnvironment,
  deviceMatchTokens,
  scanLinuxSysfs
} from './hardware-service.mjs';

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${value}\n`, 'utf8');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-hardware-'));
try {
  const pci = path.join(root, 'sys', 'bus', 'pci', 'devices', '0000:01:00.0');
  write(path.join(pci, 'vendor'), '0x10de');
  write(path.join(pci, 'device'), '0x2684');
  write(path.join(pci, 'subsystem_vendor'), '0x1462');
  write(path.join(pci, 'subsystem_device'), '0x5105');
  write(path.join(pci, 'modalias'), 'pci:v000010DEd00002684');

  const usb = path.join(root, 'sys', 'bus', 'usb', 'devices', '1-2');
  write(path.join(usb, 'idVendor'), '046d');
  write(path.join(usb, 'idProduct'), 'c534');
  write(path.join(usb, 'modalias'), 'usb:v046DpC534');

  write(path.join(root, 'etc', 'os-release'), 'ID=ubuntu\nVERSION_ID="26.04"\nPRETTY_NAME="Ubuntu 26.04"\nID_LIKE=debian');
  write(path.join(root, 'usr', 'bin', 'apt'), 'mock');
  write(path.join(root, 'usr', 'bin', 'fwupdmgr'), 'mock');
  fs.mkdirSync(path.join(root, 'etc', 'apt', 'sources.list.d'), { recursive: true });
  fs.mkdirSync(path.join(root, 'var', 'lib', 'fwupd', 'metadata'), { recursive: true });

  const environment = detectLinuxHostEnvironment({ root });
  assert.deepEqual(environment.distribution, {
    id: 'ubuntu', versionId: '26.04', prettyName: 'Ubuntu 26.04', family: 'debian'
  });
  assert.equal(environment.capabilities.fwupd.available, true);
  assert.equal(environment.capabilities.fwupd.executable, '/usr/bin/fwupdmgr');
  assert.equal(environment.capabilities.fwupd.lvfsMetadataPresent, true);
  assert.deepEqual(environment.capabilities.packageManagers, ['apt']);
  assert(environment.capabilities.repositoryConfig.some(item => item.manager === 'apt'));

  const devices = scanLinuxSysfs({ sysRoot: path.join(root, 'sys') });
  assert.equal(devices.length, 2);
  const pciDevice = devices.find(device => device.bus === 'pci');
  const usbDevice = devices.find(device => device.bus === 'usb');
  assert.deepEqual(pciDevice.ids, {
    vendor: '10de', device: '2684', subsystemVendor: '1462', subsystemDevice: '5105'
  });
  assert.equal(pciDevice.driver.status, 'unbound');
  assert.equal(pciDevice.driver.modalias, 'pci:v000010DEd00002684');
  assert.deepEqual(deviceMatchTokens(pciDevice), [
    'pci:10de:2684',
    'pci:10de:2684:1462:5105'
  ]);
  assert.deepEqual(usbDevice.ids, { vendor: '046d', product: 'c534' });
  assert.equal(usbDevice.driver.modalias, 'usb:v046DpC534');

  const catalog = {
    schema: 'swir.hardware-catalog/0.1',
    version: 'test',
    entries: [
      {
        id: 'test.gpu',
        match: { bus: 'pci', ids: ['pci:10de:2684:*'] },
        support: { kernelModules: ['nvidia'] },
        sources: [
          { class: 'vendor-official-repository', ref: 'test-only:nvidia', rollback: true },
          { class: 'random-web-download', ref: 'https://unsafe.invalid/driver.exe' }
        ]
      },
      {
        id: 'test.mouse',
        match: { bus: 'usb', ids: ['usb:046d:c534'] },
        support: { kernelModules: ['usbhid'] },
        sources: [{ class: 'kernel-in-tree', ref: 'usbhid', rollback: false }]
      }
    ]
  };

  const mapped = applyHardwareCatalog(devices, catalog);
  const mappedGpu = mapped.find(device => device.bus === 'pci');
  assert.equal(mappedGpu.catalog.matched, true);
  assert.deepEqual(mappedGpu.catalog.entryIds, ['test.gpu']);
  assert.deepEqual(mappedGpu.catalog.recommendedSources, [
    { class: 'vendor-official-repository', ref: 'test-only:nvidia', rollback: true }
  ]);
  assert.equal(mapped.find(device => device.bus === 'usb').catalog.matched, true);

  const snapshot = createHardwareSnapshot({
    devices,
    catalog,
    platform: 'linux',
    arch: 'x64',
    kernel: 'test-kernel',
    environment,
    now: new Date('2026-09-11T09:00:00.000Z')
  });
  assert.equal(snapshot.host.readOnly, true);
  assert.equal(snapshot.schema, 'swir.hardware-snapshot/0.2');
  assert.equal(snapshot.host.distribution.family, 'debian');
  assert.equal(snapshot.host.capabilities.fwupd.available, true);
  assertReadOnlyContract(snapshot);

  const unknown = applyHardwareCatalog([
    {
      key: 'pci:unknown', bus: 'pci', sysfsPath: null,
      ids: { vendor: 'ffff', device: '0001' },
      driver: { status: 'unknown', module: null, modalias: null },
      catalog: { matched: false, entryIds: [], recommendedSources: [] }
    }
  ], catalog)[0];
  assert.equal(unknown.catalog.matched, false);
  assert.deepEqual(unknown.catalog.recommendedSources, []);

  assert.throws(() => assertReadOnlyContract({ schema: 'swir.hardware-snapshot/0.2', host: { readOnly: false }, devices: [] }));
  console.log('SWIR Hardware Service self-tests: OK');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
