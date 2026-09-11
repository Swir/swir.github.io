import assert from 'node:assert/strict';
import { assertSafeDriverPlan, resolveDriverPlan } from './driver-resolver.mjs';

const catalog = {
  schema: 'swir.hardware-catalog/0.1',
  version: 'test',
  entries: [
    {
      id: 'test.gpu',
      match: { bus: 'pci', ids: ['pci:10de:2684:*'] },
      support: {
        kernelModules: ['nvidia'],
        firmware: ['linux-firmware:nvidia'],
        packages: ['nvidia-driver']
      },
      sources: [
        { class: 'vendor-official-repository', ref: 'nvidia-official', rollback: true },
        { class: 'linux-firmware', ref: 'linux-firmware', rollback: true }
      ]
    },
    {
      id: 'test.firmware',
      match: { bus: 'usb', ids: ['usb:1234:5678'] },
      support: { firmware: ['vendor-device-firmware'] },
      sources: [{ class: 'fwupd-lvfs', ref: 'LVFS', rollback: true }]
    }
  ]
};

const snapshot = {
  schema: 'swir.hardware-snapshot/0.1',
  generatedAt: '2026-09-11T10:00:00.000Z',
  host: { platform: 'linux', arch: 'x64', kernel: 'test', readOnly: true },
  devices: [
    {
      key: 'pci:0000:01:00.0', bus: 'pci', sysfsPath: '/sys/mock/gpu',
      ids: { vendor: '10de', device: '2684' },
      driver: { status: 'unbound', module: null },
      catalog: {
        matched: true,
        entryIds: ['test.gpu'],
        recommendedSources: [
          { class: 'vendor-official-repository', ref: 'nvidia-official', rollback: true },
          { class: 'linux-firmware', ref: 'linux-firmware', rollback: true }
        ]
      }
    },
    {
      key: 'pci:0000:02:00.0', bus: 'pci', sysfsPath: '/sys/mock/healthy',
      ids: { vendor: '10de', device: '2684' },
      driver: { status: 'loaded', module: 'nvidia' },
      catalog: {
        matched: true,
        entryIds: ['test.gpu'],
        recommendedSources: [{ class: 'vendor-official-repository', ref: 'nvidia-official', rollback: true }]
      }
    },
    {
      key: 'usb:1-2', bus: 'usb', sysfsPath: '/sys/mock/usb',
      ids: { vendor: '1234', product: '5678' },
      driver: { status: 'loaded', module: 'usbhid' },
      catalog: {
        matched: true,
        entryIds: ['test.firmware'],
        recommendedSources: [{ class: 'fwupd-lvfs', ref: 'LVFS', rollback: true }]
      }
    },
    {
      key: 'pci:unknown', bus: 'pci', sysfsPath: '/sys/mock/unknown',
      ids: { vendor: 'ffff', device: '0001' },
      driver: { status: 'unknown', module: null },
      catalog: { matched: false, entryIds: [], recommendedSources: [] }
    }
  ]
};

const plan = resolveDriverPlan(snapshot, catalog, { now: new Date('2026-09-11T10:30:00.000Z') });
assert.equal(plan.schema, 'swir.driver-plan/0.1');
assert.equal(plan.mode, 'preview');
assert.equal(plan.readOnly, true);
assert.equal(plan.autoExecutable, false);
assert.equal(plan.summary.devices, 4);
assert.equal(plan.summary.matched, 3);
assert.equal(plan.summary.healthy, 2);
assert.equal(plan.summary.attention, 1);
assert(plan.operations.some(op => op.kind === 'diagnose-unbound'));
assert(plan.operations.some(op => op.kind === 'review-module'));
assert(plan.operations.some(op => op.kind === 'review-firmware'));
assert(plan.operations.some(op => op.kind === 'review-package'));
assert(plan.operations.some(op => op.kind === 'review-fwupd'));
assert(plan.operations.every(op => op.state === 'proposed'));
assert(plan.operations.every(op => op.sources.every(source => source.class !== 'random-web-download')));
assertSafeDriverPlan(plan);

const unsafe = structuredClone(plan);
unsafe.operations[0].sources.push({ class: 'random-web-download', ref: 'https://unsafe.invalid/driver.bin' });
assert.throws(() => assertSafeDriverPlan(unsafe), /Untrusted driver source class/);

const executable = structuredClone(plan);
executable.autoExecutable = true;
assert.throws(() => assertSafeDriverPlan(executable), /preview-only/);

assert.throws(() => resolveDriverPlan({ ...snapshot, host: { ...snapshot.host, readOnly: false } }, catalog), /trusted read-only/);
console.log('SWIR Driver Resolver self-tests: OK');
