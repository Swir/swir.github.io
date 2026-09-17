import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertReadOnlyContract,
  collectHardwareSnapshot,
  loadCatalog
} from './hardware-service.mjs';
import { assertSafeDriverPlan, resolveDriverPlan } from './driver-resolver.mjs';
import { assertSafeDriverCenterReport, createDriverCenterReport } from './driver-center-service.mjs';
import { FwupdLvfsService, assertSafeFwupdLvfsInventory } from './fwupd-lvfs-service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG = path.join(here, 'hardware-catalog.json');
const DEFAULT_TRUSTED_SOURCES = path.join(here, '..', 'contracts', 'trusted-sources.json');

function fail(code, message) {
  const error = new Error(message);
  error.name = 'DriverCenterRuntimeError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function trustedSourcePolicy(trustedSources) {
  const policy = trustedSources?.policy || {};
  return Object.freeze({
    unknownHardwareAutoDownload: policy.unknownHardwareMayAutoDownload === true,
    arbitraryDriverUrls: policy.arbitraryDriverUrls === true,
    windowsKernelDriversAsLinuxDrivers: policy.windowsKernelDriversAsLinuxDrivers === true,
    signatureVerificationRequiredForRepositories: policy.signatureVerificationRequiredForRepositories !== false,
    privilegedMutationRequiresPlan: policy.privilegedMutationRequiresPlan !== false,
    privilegedMutationRequiresJournal: policy.privilegedMutationRequiresJournal !== false
  });
}

function firmwareFallback(probe, error = null) {
  return Object.freeze({
    provider: 'fwupd-lvfs',
    available: probe?.available === true,
    binaryTrusted: probe?.trustedBinary === true,
    inventoryReady: false,
    candidates: 0,
    ignoredNonLvfsCandidates: 0,
    errorCode: error?.code || error?.name || null,
    mutationAuthorized: false
  });
}

async function collectFirmware(service) {
  const probe = await service.probe();
  if (!probe.available) return firmwareFallback(probe);
  assert(probe.trustedBinary === true, 'FWUPD_BINARY_UNTRUSTED', 'fwupd binary trust probe failed');
  try {
    const inventory = await service.inventory();
    assertSafeFwupdLvfsInventory(inventory);
    return Object.freeze({
      provider: inventory.provider,
      available: inventory.available === true,
      binaryTrusted: inventory.probe?.trustedBinary === true,
      inventoryReady: true,
      candidates: inventory.candidates.length,
      ignoredNonLvfsCandidates: inventory.ignoredNonLvfsCandidates,
      updates: clone(inventory.candidates),
      mutationAuthorized: false
    });
  } catch (error) {
    return firmwareFallback(probe, error);
  }
}

function summarizeHardware(snapshot, report) {
  const devices = snapshot.devices || [];
  return Object.freeze({
    inventoryProvider: 'linux-sysfs',
    platform: snapshot.host?.platform || null,
    architecture: snapshot.host?.arch || null,
    kernelRelease: snapshot.host?.kernel || null,
    distribution: clone(snapshot.host?.distribution || null),
    total: devices.length,
    pci: devices.filter(device => device.bus === 'pci').length,
    usb: devices.filter(device => device.bus === 'usb').length,
    loadedDrivers: devices.filter(device => device.driver?.status === 'loaded').length,
    unboundDrivers: devices.filter(device => device.driver?.status === 'unbound').length,
    catalogMatched: devices.filter(device => device.catalog?.matched === true).length,
    healthy: report.summary?.healthy || 0,
    attention: report.summary?.attention || 0,
    unknown: report.summary?.unknown || 0
  });
}

function summarizePlan(plan) {
  const operations = plan.operations || [];
  return Object.freeze({
    mode: plan.mode,
    readOnly: plan.readOnly,
    autoExecutable: plan.autoExecutable,
    operations: operations.length,
    privilegedOperations: operations.filter(operation => operation.requiresPrivilege === true).length,
    sourceSupportedRollback: operations.filter(operation => operation.rollback === 'source-supported').length,
    requiredBeforeApplyRollback: operations.filter(operation => operation.rollback === 'required-before-apply').length
  });
}

export async function buildDriverCenterRuntime({
  catalogPath = DEFAULT_CATALOG,
  trustedSourcesPath = DEFAULT_TRUSTED_SOURCES,
  snapshotProvider = null,
  fwupdService = null,
  now = new Date()
} = {}) {
  const catalog = loadCatalog(catalogPath);
  const trustedSources = JSON.parse(fs.readFileSync(trustedSourcesPath, 'utf8'));
  assert(trustedSources?.schema === 'swir.trusted-sources/0.1', 'TRUSTED_SOURCES_SCHEMA_INVALID', 'Trusted source policy schema mismatch');

  const snapshot = snapshotProvider
    ? await snapshotProvider({ catalog, now })
    : collectHardwareSnapshot({ catalog, now });
  assertReadOnlyContract(snapshot);

  const plan = resolveDriverPlan(snapshot, catalog, { now });
  assertSafeDriverPlan(plan);
  const report = createDriverCenterReport(snapshot, plan, trustedSources, { now });
  assertSafeDriverCenterReport(report);

  const firmware = await collectFirmware(fwupdService || new FwupdLvfsService());
  const policy = trustedSourcePolicy(trustedSources);
  assert(policy.unknownHardwareAutoDownload === false, 'UNKNOWN_HARDWARE_AUTO_DOWNLOAD', 'Unknown hardware auto-download must stay disabled');
  assert(policy.arbitraryDriverUrls === false, 'ARBITRARY_DRIVER_URLS', 'Arbitrary driver URLs must stay disabled');
  assert(policy.windowsKernelDriversAsLinuxDrivers === false, 'WINDOWS_DRIVER_POLICY_INVALID', 'Windows kernel drivers are not a Linux driver path');
  assert(policy.privilegedMutationRequiresPlan === true && policy.privilegedMutationRequiresJournal === true, 'MUTATION_POLICY_WEAK', 'Privileged mutations require plan and journal');

  return Object.freeze({
    schema: 'swir.driver-center-runtime/0.1',
    generatedAt: now.toISOString(),
    mode: 'diagnostics',
    readOnly: true,
    autoMutation: false,
    hardware: summarizeHardware(snapshot, report),
    driverPlan: summarizePlan(plan),
    firmware,
    policy,
    devices: clone(report.devices),
    operations: clone(report.operations),
    violations: clone(report.violations),
    passed: report.summary?.violations === 0
  });
}

export function assertSafeDriverCenterRuntime(runtime) {
  assert(runtime?.schema === 'swir.driver-center-runtime/0.1', 'RUNTIME_SCHEMA_INVALID', 'Driver Center runtime schema mismatch');
  assert(runtime.mode === 'diagnostics' && runtime.readOnly === true && runtime.autoMutation === false, 'RUNTIME_MUTATION_BOUNDARY_INVALID', 'Driver Center runtime must remain diagnostics-only');
  assert(runtime.hardware?.inventoryProvider === 'linux-sysfs', 'HARDWARE_PROVIDER_INVALID', 'Driver Center runtime must use Linux sysfs inventory');
  assert(Number.isInteger(runtime.hardware?.total) && runtime.hardware.total >= 0, 'HARDWARE_COUNT_INVALID', 'Driver Center hardware count is invalid');
  assert(runtime.driverPlan?.readOnly === true && runtime.driverPlan?.autoExecutable === false, 'DRIVER_PLAN_BOUNDARY_INVALID', 'Driver plan must remain preview-only');
  assert(runtime.firmware?.provider === 'fwupd-lvfs' && runtime.firmware?.mutationAuthorized === false, 'FWUPD_BOUNDARY_INVALID', 'Firmware discovery must not pre-authorize mutation');
  assert(runtime.policy?.unknownHardwareAutoDownload === false, 'UNKNOWN_HARDWARE_AUTO_DOWNLOAD', 'Unknown hardware auto-download must stay disabled');
  assert(runtime.policy?.arbitraryDriverUrls === false, 'ARBITRARY_DRIVER_URLS', 'Arbitrary driver URLs must stay disabled');
  assert(runtime.policy?.windowsKernelDriversAsLinuxDrivers === false, 'WINDOWS_DRIVER_POLICY_INVALID', 'Windows kernel drivers are not a Linux driver path');
  assert(runtime.policy?.privilegedMutationRequiresPlan === true && runtime.policy?.privilegedMutationRequiresJournal === true, 'MUTATION_POLICY_WEAK', 'Privileged mutations require plan and journal');
  assert(Array.isArray(runtime.violations) && runtime.violations.length === 0, 'DRIVER_CENTER_VIOLATIONS', 'Driver Center runtime contains policy violations');
  assert(runtime.passed === true, 'DRIVER_CENTER_RUNTIME_FAILED', 'Driver Center runtime did not pass');
  return true;
}

export const DriverCenterRuntimePolicy = Object.freeze({
  schema: 'swir.driver-center-runtime-policy/0.1',
  hardwareInventory: 'linux-sysfs',
  driverResolver: 'preview-only',
  firmwareInventory: 'fwupd-lvfs-read-only',
  unknownHardwareAutoDownload: false,
  arbitraryDriverUrls: false,
  windowsKernelDriversAsLinuxDrivers: false,
  privilegedMutationRequiresPlan: true,
  privilegedMutationRequiresJournal: true,
  automaticMutation: false
});
