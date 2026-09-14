const DEFAULT_ALLOWED_DRIVER_SOURCE_CLASSES = new Set([
  'kernel-in-tree',
  'linux-firmware',
  'distribution-repository',
  'fwupd-lvfs',
  'vendor-official-repository'
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePolicy(trustedSources = {}) {
  const policy = trustedSources?.policy || {};
  return {
    unknownHardwareMayAutoDownload: policy.unknownHardwareMayAutoDownload === true,
    arbitraryDriverUrls: policy.arbitraryDriverUrls === true,
    windowsKernelDriversAsLinuxDrivers: policy.windowsKernelDriversAsLinuxDrivers === true,
    signatureVerificationRequiredForRepositories: policy.signatureVerificationRequiredForRepositories !== false,
    privilegedMutationRequiresPlan: policy.privilegedMutationRequiresPlan !== false,
    privilegedMutationRequiresJournal: policy.privilegedMutationRequiresJournal !== false,
    forbiddenAutomaticDriverArtifacts: asArray(trustedSources?.forbiddenAutomaticDriverArtifacts).map(value => String(value).toLowerCase()),
    allowedDriverSourceClasses: new Set(
      asArray(trustedSources?.driverSourceClasses).length
        ? trustedSources.driverSourceClasses
        : [...DEFAULT_ALLOWED_DRIVER_SOURCE_CLASSES]
    )
  };
}

function sourceViolations(source, policy, context = {}) {
  const violations = [];
  const sourceClass = String(source?.class || '');
  const ref = String(source?.ref || '').trim();
  const lower = ref.toLowerCase();
  const base = { deviceKey: context.deviceKey || null, operationId: context.operationId || null };

  if (!policy.allowedDriverSourceClasses.has(sourceClass)) {
    violations.push({ ...base, code: 'UNTRUSTED_SOURCE_CLASS', message: `Driver source class is not allowlisted: ${sourceClass || '(empty)'}` });
  }
  if (!policy.arbitraryDriverUrls && /^https?:\/\//i.test(ref)) {
    violations.push({ ...base, code: 'ARBITRARY_DRIVER_URL', message: 'Direct driver URLs are forbidden; use an allowlisted repository/provider reference.' });
  }
  if (policy.forbiddenAutomaticDriverArtifacts.some(ext => lower.endsWith(ext))) {
    violations.push({ ...base, code: 'FORBIDDEN_DRIVER_ARTIFACT', message: `Driver source references a forbidden automatic artifact: ${ref}` });
  }
  if (sourceClass === 'vendor-official-repository' && !String(source?.repositoryId || '').trim()) {
    violations.push({ ...base, code: 'VENDOR_REPOSITORY_ID_REQUIRED', message: 'Official vendor repository sources require an explicit repositoryId.' });
  }
  return violations;
}

function deviceAssessment(device) {
  const matched = device?.catalog?.matched === true;
  const driverStatus = device?.driver?.status || 'unknown';
  const module = device?.driver?.module || null;
  const reasons = [];

  if (!matched) reasons.push('No Hardware Catalog match; keep the device diagnostic-only and do not auto-download anything.');
  if (driverStatus === 'unbound') reasons.push('Device exposes a modalias but no kernel driver is bound.');
  if (driverStatus === 'unknown') reasons.push('Driver binding state could not be determined safely.');
  if (driverStatus === 'loaded' && module) reasons.push(`Kernel driver module ${module} is loaded.`);

  let status = 'unknown';
  if (matched && driverStatus === 'loaded') status = 'healthy';
  else if (matched && driverStatus !== 'loaded') status = 'attention';

  return {
    key: String(device?.key || ''),
    bus: device?.bus || 'platform',
    ids: device?.ids || {},
    status,
    driver: {
      status: driverStatus,
      module,
      modalias: device?.driver?.modalias || null
    },
    catalog: {
      matched,
      entryIds: asArray(device?.catalog?.entryIds),
      recommendedSources: asArray(device?.catalog?.recommendedSources)
    },
    reasons
  };
}

export function createDriverCenterReport(snapshot, plan, trustedSources, { now = new Date() } = {}) {
  if (snapshot?.schema !== 'swir.hardware-snapshot/0.2' || snapshot?.host?.readOnly !== true) {
    throw new Error('Driver Center requires a read-only SWIR hardware snapshot');
  }
  if (plan?.schema !== 'swir.driver-plan/0.1' || plan?.readOnly !== true || plan?.autoExecutable !== false) {
    throw new Error('Driver Center requires a preview-only SWIR driver plan');
  }

  const normalized = normalizePolicy(trustedSources);
  const policy = {
    unknownHardwareMayAutoDownload: normalized.unknownHardwareMayAutoDownload,
    arbitraryDriverUrls: normalized.arbitraryDriverUrls,
    windowsKernelDriversAsLinuxDrivers: normalized.windowsKernelDriversAsLinuxDrivers,
    signatureVerificationRequiredForRepositories: normalized.signatureVerificationRequiredForRepositories,
    privilegedMutationRequiresPlan: normalized.privilegedMutationRequiresPlan,
    privilegedMutationRequiresJournal: normalized.privilegedMutationRequiresJournal
  };

  const devices = asArray(snapshot.devices).map(deviceAssessment);
  const violations = [];

  if (policy.unknownHardwareMayAutoDownload) {
    violations.push({ code: 'UNKNOWN_HARDWARE_AUTO_DOWNLOAD_ENABLED', message: 'Unknown hardware auto-download must remain disabled.', deviceKey: null, operationId: null });
  }
  if (policy.arbitraryDriverUrls) {
    violations.push({ code: 'ARBITRARY_DRIVER_URLS_ENABLED', message: 'Arbitrary driver URLs must remain disabled.', deviceKey: null, operationId: null });
  }
  if (policy.windowsKernelDriversAsLinuxDrivers) {
    violations.push({ code: 'WINDOWS_KERNEL_DRIVER_POLICY_INVALID', message: 'Windows kernel drivers cannot be treated as the general Linux hardware path.', deviceKey: null, operationId: null });
  }
  if (!policy.privilegedMutationRequiresPlan || !policy.privilegedMutationRequiresJournal) {
    violations.push({ code: 'PRIVILEGED_TRANSACTION_POLICY_WEAK', message: 'Privileged driver/firmware mutations require both a plan and transaction journal.', deviceKey: null, operationId: null });
  }

  for (const device of devices) {
    for (const source of device.catalog.recommendedSources) {
      violations.push(...sourceViolations(source, normalized, { deviceKey: device.key }));
    }
  }
  for (const operation of asArray(plan.operations)) {
    for (const source of asArray(operation?.sources)) {
      violations.push(...sourceViolations(source, normalized, { deviceKey: operation?.deviceKey, operationId: operation?.id }));
    }
    if (operation?.requiresPrivilege === true && operation?.rollback === 'not-required') {
      violations.push({ code: 'ROLLBACK_METADATA_REQUIRED', message: 'Privileged operation lacks rollback/recovery handling.', deviceKey: operation?.deviceKey || null, operationId: operation?.id || null });
    }
  }

  const summary = {
    devices: devices.length,
    healthy: devices.filter(device => device.status === 'healthy').length,
    attention: devices.filter(device => device.status === 'attention').length,
    unknown: devices.filter(device => device.status === 'unknown').length,
    unbound: devices.filter(device => device.driver.status === 'unbound').length,
    operations: asArray(plan.operations).length,
    violations: violations.length
  };

  return {
    schema: 'swir.driver-center-report/0.1',
    generatedAt: now.toISOString(),
    mode: 'diagnostics',
    readOnly: true,
    autoMutation: false,
    host: snapshot.host,
    policy,
    summary,
    devices,
    operations: asArray(plan.operations),
    violations
  };
}

export function assertSafeDriverCenterReport(report) {
  if (report?.schema !== 'swir.driver-center-report/0.1') throw new Error('Driver Center report schema mismatch');
  if (report?.mode !== 'diagnostics' || report?.readOnly !== true || report?.autoMutation !== false) {
    throw new Error('Driver Center must remain diagnostics-only and non-mutating');
  }
  if (report?.policy?.unknownHardwareMayAutoDownload !== false) throw new Error('Unknown hardware auto-download is forbidden');
  if (report?.policy?.arbitraryDriverUrls !== false) throw new Error('Arbitrary driver URLs are forbidden');
  if (report?.policy?.windowsKernelDriversAsLinuxDrivers !== false) throw new Error('Windows kernel drivers are not a Linux driver path');
  if (report?.policy?.privilegedMutationRequiresPlan !== true || report?.policy?.privilegedMutationRequiresJournal !== true) {
    throw new Error('Privileged hardware changes require plan + journal policy');
  }
  if (asArray(report?.violations).length) {
    throw new Error(`Unsafe Driver Center report: ${report.violations.map(item => item.code).join(', ')}`);
  }
  return true;
}
