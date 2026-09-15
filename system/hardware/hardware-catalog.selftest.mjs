import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(here, 'hardware-catalog.json'), 'utf8'));

const allowedSourceClasses = new Set([
  'kernel-in-tree',
  'linux-firmware',
  'distribution-repository',
  'fwupd-lvfs',
  'vendor-official-repository'
]);
const allowedBuses = new Set(['pci', 'usb']);
const entryIds = new Set();
const hardwareIds = new Set();

function assert(condition, message) {
  if (!condition) throw new Error(`Hardware catalog policy violation: ${message}`);
}

function requireSafeToken(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} is required`);
  assert(value.length <= 256, `${label} is too long`);
  assert(!/[\u0000-\u001f\u007f]/.test(value), `${label} contains control characters`);
  assert(!/^https?:\/\//i.test(value), `${label} must not be an arbitrary URL`);
}

assert(catalog.schema === 'swir.hardware-catalog/0.1', 'unexpected schema');
assert(typeof catalog.version === 'string' && catalog.version.length > 0, 'version is required');
assert(Array.isArray(catalog.entries), 'entries must be an array');

for (const entry of catalog.entries) {
  assert(entry && typeof entry === 'object', 'entry must be an object');
  assert(typeof entry.id === 'string' && entry.id.length > 0, 'entry id is required');
  assert(!entryIds.has(entry.id), `duplicate entry id ${entry.id}`);
  entryIds.add(entry.id);

  assert(allowedBuses.has(entry.match?.bus), `${entry.id}: unsupported bus ${entry.match?.bus}`);
  assert(Array.isArray(entry.match?.ids) && entry.match.ids.length > 0, `${entry.id}: hardware ids are required`);
  for (const hardwareId of entry.match.ids) {
    requireSafeToken(hardwareId, `${entry.id}: hardware id`);
    assert(hardwareId.startsWith(`${entry.match.bus}:`), `${entry.id}: malformed hardware id ${hardwareId}`);
    assert(!hardwareIds.has(hardwareId), `${entry.id}: duplicate hardware id ${hardwareId}`);
    hardwareIds.add(hardwareId);
  }

  assert(Array.isArray(entry.support?.kernelModules), `${entry.id}: kernelModules must be an array`);
  assert(Array.isArray(entry.support?.firmware), `${entry.id}: firmware must be an array`);
  assert(Array.isArray(entry.support?.packages), `${entry.id}: packages must be an array`);
  for (const module of entry.support.kernelModules) requireSafeToken(module, `${entry.id}: kernel module`);
  for (const firmware of entry.support.firmware) requireSafeToken(firmware, `${entry.id}: firmware`);
  for (const packageName of entry.support.packages) requireSafeToken(packageName, `${entry.id}: package`);
  assert(Array.isArray(entry.sources) && entry.sources.length > 0, `${entry.id}: at least one trusted source is required`);

  const sourceRefs = new Set();
  for (const source of entry.sources) {
    assert(allowedSourceClasses.has(source?.class), `${entry.id}: source class ${source?.class} is not trusted`);
    requireSafeToken(source.ref, `${entry.id}: source ref`);
    assert(!sourceRefs.has(source.ref), `${entry.id}: duplicate source ref ${source.ref}`);
    sourceRefs.add(source.ref);
    assert(typeof source.rollback === 'boolean', `${entry.id}: rollback declaration is required`);

    if (source.class === 'kernel-in-tree') {
      assert(source.ref.startsWith('linux:'), `${entry.id}: kernel source must use linux: ref`);
      assert(source.rollback === false, `${entry.id}: in-tree kernel source must not claim package rollback`);
    }
    if (source.class === 'linux-firmware') {
      assert(source.ref.startsWith('linux-firmware:'), `${entry.id}: firmware source must use linux-firmware: ref`);
      assert(source.rollback === true, `${entry.id}: linux-firmware changes require rollback support`);
    }
    if (source.class === 'distribution-repository') {
      assert(source.ref.startsWith('package:'), `${entry.id}: distribution source must use package: ref`);
      assert(source.rollback === true, `${entry.id}: distribution package changes require rollback support`);
    }
    if (source.class === 'fwupd-lvfs') {
      assert(source.ref.startsWith('lvfs:'), `${entry.id}: LVFS source must use lvfs: ref`);
      assert(source.rollback === true, `${entry.id}: firmware update plans must declare rollback support`);
    }
    if (source.class === 'vendor-official-repository') {
      assert(source.ref.startsWith('vendor:'), `${entry.id}: vendor source must use vendor: ref`);
      assert(source.rollback === true, `${entry.id}: vendor package changes require rollback support`);
    }
  }

  if (entry.support.firmware.length > 0) {
    assert(entry.sources.some(source => source.class === 'linux-firmware' || source.class === 'fwupd-lvfs' || source.class === 'distribution-repository'), `${entry.id}: firmware declaration requires a controlled firmware source`);
  }
  if (entry.support.packages.length > 0) {
    assert(entry.sources.some(source => source.class === 'distribution-repository' || source.class === 'vendor-official-repository'), `${entry.id}: package declaration requires a controlled package repository`);
  }
}

console.log(`Hardware catalog policy OK: ${catalog.entries.length} entries, ${hardwareIds.size} hardware ids, trusted sources only, rollback/source invariants enforced.`);
