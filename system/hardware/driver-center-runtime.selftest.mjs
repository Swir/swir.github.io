import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHardwareSnapshot } from './hardware-service.mjs';
import { assertSafeDriverCenterRuntime, buildDriverCenterRuntime, DriverCenterRuntimePolicy } from './driver-center-runtime.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-driver-center-runtime-'));
try {
  const catalogPath = path.join(root, 'hardware-catalog.json');
  const trustedSourcesPath = path.join(root, 'trusted-sources.json');
  fs.writeFileSync(catalogPath, JSON.stringify({
    schema: 'swir.hardware-catalog/0.1',
    version: 'test',
    entries: [{
      id: 'pci.virtio.block.test',
      match: { bus: 'pci', ids: ['pci:1af4:1001'] },
      support: { kernelModules: ['virtio-pci'], firmware: [], packages: [] },
      sources: [{ class: 'kernel-in-tree', ref: 'linux:drivers/block/virtio_blk', rollback: false }]
    }]
  }));
  fs.writeFileSync(trustedSourcesPath, JSON.stringify({
    schema: 'swir.trusted-sources/0.1',
    driverSourceClasses: ['kernel-in-tree', 'linux-firmware', 'distribution-repository', 'fwupd-lvfs', 'vendor-official-repository'],
    forbiddenAutomaticDriverArtifacts: ['.exe', '.msi', '.sys'],
    policy: {
      unknownHardwareMayAutoDownload: false,
      arbitraryDriverUrls: false,
      windowsKernelDriversAsLinuxDrivers: false,
      signatureVerificationRequiredForRepositories: true,
      privilegedMutationRequiresPlan: true,
      privilegedMutationRequiresJournal: true
    }
  }));

  const fwupdService = {
    async probe() { return { available: true, binary: '/usr/bin/fwupdmgr', trustedBinary: true, ownerUid: 0 }; },
    async inventory() {
      return {
        schema: 'swir.fwupd-lvfs-inventory/0.1', available: true, readOnly: true, mutationCapable: false,
        provider: 'fwupd-lvfs', trustedRemoteId: 'lvfs', devices: [],
        candidates: [{
          deviceId: 'fixture-device', deviceName: 'Fixture firmware', currentVersion: '1', version: '2',
          releaseId: 'fixture-release', remoteId: 'lvfs', name: 'Fixture', summary: null, urgency: null,
          checksums: ['sha256:fixture'], requiresReboot: true,
          source: { class: 'fwupd-lvfs', repositoryId: 'lvfs', ref: 'fwupd:fixture-device:fixture-release' },
          trustedSource: true, directDownloadUrlExposed: false, mutationAuthorized: false
        }],
        ignoredNonLvfsCandidates: 0,
        probe: { available: true, trustedBinary: true, ownerUid: 0 }
      };
    }
  };

  const runtime = await buildDriverCenterRuntime({
    catalogPath,
    trustedSourcesPath,
    fwupdService,
    now: new Date('2026-09-17T10:00:00.000Z'),
    snapshotProvider: ({ catalog, now }) => createHardwareSnapshot({
      catalog,
      now,
      platform: 'linux',
      arch: 'x64',
      kernel: '6.12.0-test',
      environment: {
        distribution: { id: 'debian', versionId: '13', prettyName: 'Debian GNU/Linux 13', family: 'debian' },
        capabilities: { fwupd: { available: true, executable: '/usr/bin/fwupdmgr', lvfsMetadataPresent: true }, packageManagers: ['apt'], repositoryConfig: [{ manager: 'apt', path: '/etc/apt/sources.list.d' }] }
      },
      devices: [{
        key: 'pci:0000:00:01.0', bus: 'pci', sysfsPath: '/sys/bus/pci/devices/0000:00:01.0',
        ids: { vendor: '1af4', device: '1001' }, driver: { status: 'loaded', module: 'virtio-pci', modalias: 'pci:test' },
        catalog: { matched: false, entryIds: [], recommendedSources: [] }
      }]
    })
  });

  assertSafeDriverCenterRuntime(runtime);
  assert.equal(runtime.hardware.total, 1);
  assert.equal(runtime.hardware.pci, 1);
  assert.equal(runtime.hardware.loadedDrivers, 1);
  assert.equal(runtime.hardware.catalogMatched, 1);
  assert.equal(runtime.hardware.healthy, 1);
  assert.equal(runtime.driverPlan.operations, 0);
  assert.equal(runtime.firmware.inventoryReady, true);
  assert.equal(runtime.firmware.candidates, 1);
  assert.equal(runtime.firmware.mutationAuthorized, false);
  assert.equal(runtime.violations.length, 0);
  assert.equal(runtime.passed, true);
  assert.equal(DriverCenterRuntimePolicy.automaticMutation, false);

  const offline = await buildDriverCenterRuntime({
    catalogPath,
    trustedSourcesPath,
    now: new Date('2026-09-17T10:00:00.000Z'),
    fwupdService: { async probe() { return { available: false, trustedBinary: false, reason: 'not-installed' }; } },
    snapshotProvider: ({ catalog, now }) => createHardwareSnapshot({
      catalog, now, platform: 'linux', arch: 'x64', kernel: '6.12.0-test',
      devices: [{ key: 'pci:0000:00:01.0', bus: 'pci', sysfsPath: '/sys/bus/pci/devices/0000:00:01.0', ids: { vendor: '1af4', device: '1001' }, driver: { status: 'loaded', module: 'virtio-pci', modalias: null }, catalog: { matched: false, entryIds: [], recommendedSources: [] } }]
    })
  });
  assertSafeDriverCenterRuntime(offline);
  assert.equal(offline.firmware.available, false);
  assert.equal(offline.firmware.inventoryReady, false);

  console.log('Driver Center runtime self-test: OK');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
