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
const pciIdPattern = /^pci:[0-9a-f]{4}:[0-9a-f]{4}$/;
const usbIdPattern = /^usb:[0-9a-f]{4}:[0-9a-f]{4}$/;
const modulePattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;
const packagePattern = /^[a-z0-9][a-z0-9+._:-]{0,127}$/i;

function assert(condition, message) {
  if (!condition) throw new Error(`Hardware catalog policy violation: ${message}`);
}

function requireSafeToken(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} is required`);
  assert(value === value.trim(), `${label} must not contain surrounding whitespace`);
  assert(value.length <= 256, `${label} is too long`);
  assert(!/[\u0000-\u001f\u007f]/.test(value), `${label} contains control characters`);
  assert(!/^https?:\/\//i.test(value), `${label} must not be an arbitrary URL`);
}

function requireUniqueTokens(values, label) {
  const seen = new Set();
  for (const value of values) {
    requireSafeToken(value, label);
    assert(!seen.has(value), `duplicate ${label} ${value}`);
    seen.add(value);
  }
}

assert(catalog.schema === 'swir.hardware-catalog/0.1', 'unexpected schema');
assert(typeof catalog.version === 'string' && catalog.version.length > 0, 'version is required');
assert(Array.isArray(catalog.entries), 'entries must be an array');

for (const entry of catalog.entries) {
  assert(entry && typeof entry === 'object', 'entry must be an object');
  requireSafeToken(entry.id, 'entry id');
  assert(!entryIds.has(entry.id), `duplicate entry id ${entry.id}`);
  entryIds.add(entry.id);

  assert(allowedBuses.has(entry.match?.bus), `${entry.id}: unsupported bus ${entry.match?.bus}`);
  assert(Array.isArray(entry.match?.ids) && entry.match.ids.length > 0, `${entry.id}: hardware ids are required`);
  for (const hardwareId of entry.match.ids) {
    requireSafeToken(hardwareId, `${entry.id}: hardware id`);
    const normalizedId = hardwareId.toLowerCase();
    assert(hardwareId === normalizedId, `${entry.id}: hardware id must be lowercase canonical form: ${hardwareId}`);
    const validShape = entry.match.bus === 'pci' ? pciIdPattern.test(hardwareId) : usbIdPattern.test(hardwareId);
    assert(validShape, `${entry.id}: malformed ${entry.match.bus} vendor/device id ${hardwareId}`);
    assert(!hardwareIds.has(hardwareId), `${entry.id}: duplicate hardware id ${hardwareId}`);
    hardwareIds.add(hardwareId);
  }

  assert(Array.isArray(entry.support?.kernelModules), `${entry.id}: kernelModules must be an array`);
  assert(Array.isArray(entry.support?.firmware), `${entry.id}: firmware must be an array`);
  assert(Array.isArray(entry.support?.packages), `${entry.id}: packages must be an array`);
  requireUniqueTokens(entry.support.kernelModules, `${entry.id}: kernel module`);
  requireUniqueTokens(entry.support.firmware, `${entry.id}: firmware`);
  requireUniqueTokens(entry.support.packages, `${entry.id}: package`);
  for (const module of entry.support.kernelModules)
    assert(modulePattern.test(module), `${entry.id}: malformed kernel module ${module}`);
  for (const packageName of entry.support.packages)
    assert(packagePattern.test(packageName), `${entry.id}: malformed package name ${packageName}`);

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

  const hasKernelSource = entry.sources.some(source => source.class === 'kernel-in-tree');
  const hasFirmwareSource = entry.sources.some(source => source.class === 'linux-firmware' || source.class === 'fwupd-lvfs' || source.class === 'distribution-repository');
  const hasPackageSource = entry.sources.some(source => source.class === 'distribution-repository' || source.class === 'vendor-official-repository');

  if (entry.support.kernelModules.length > 0)
    assert(hasKernelSource || hasPackageSource, `${entry.id}: kernel module declaration requires an in-tree or controlled package source`);
  if (hasKernelSource)
    assert(entry.support.kernelModules.length > 0, `${entry.id}: kernel-in-tree source requires at least one mapped module`);
  if (entry.support.firmware.length > 0)
    assert(hasFirmwareSource, `${entry.id}: firmware declaration requires a controlled firmware source`);
  if (entry.support.packages.length > 0)
    assert(hasPackageSource, `${entry.id}: package declaration requires a controlled package repository`);
  if (entry.sources.some(source => source.class === 'vendor-official-repository'))
    assert(entry.support.packages.length > 0, `${entry.id}: vendor repository source requires an explicit package mapping`);
}

console.log(`Hardware catalog policy OK: ${catalog.entries.length} entries, ${hardwareIds.size} canonical hardware ids, trusted sources only, identity/source/rollback invariants enforced.`);
