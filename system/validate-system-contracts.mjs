import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const contracts = path.join(ROOT, 'contracts');

function readJson(name) {
  const full = path.join(contracts, name);
  const raw = fs.readFileSync(full, 'utf8');
  try { return JSON.parse(raw); }
  catch (error) { throw new Error(`${name}: invalid JSON: ${error.message}`); }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const hardware = readJson('hardware-catalog.schema.json');
const snapshot = readJson('hardware-snapshot.schema.json');
const driverPlan = readJson('driver-plan.schema.json');
const driverCenter = readJson('driver-center-report.schema.json');
const providers = readJson('package-provider.schema.json');
const trust = readJson('trusted-sources.json');
const baseImageSchema = readJson('system-base-image-profile.schema.json');
const imageReadinessSchema = readJson('system-image-readiness.schema.json');
const baselineCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'hardware', 'hardware-catalog.json'), 'utf8'));
const baseImageProfile = JSON.parse(fs.readFileSync(path.join(ROOT, 'image', 'debian13-base-image-profile.json'), 'utf8'));

assert(hardware.$schema?.includes('2020-12'), 'hardware schema must use JSON Schema 2020-12');
assert(hardware.properties?.schema?.const === 'swir.hardware-catalog/0.1', 'hardware schema ID mismatch');
assert(snapshot.$schema?.includes('2020-12'), 'snapshot schema must use JSON Schema 2020-12');
assert(snapshot.properties?.schema?.const === 'swir.hardware-snapshot/0.2', 'snapshot schema ID mismatch');
assert(snapshot.properties?.host?.properties?.readOnly?.const === true, 'Hardware Service snapshot must remain read-only');
assert(snapshot.properties?.host?.properties?.distribution, 'Hardware Service snapshot must expose distribution facts');
assert(snapshot.properties?.host?.properties?.capabilities, 'Hardware Service snapshot must expose host capabilities');
assert(snapshot.$defs?.device?.properties?.driver?.properties?.modalias, 'Hardware Service snapshot must expose modalias');
assert(driverPlan.$schema?.includes('2020-12'), 'driver plan schema must use JSON Schema 2020-12');
assert(driverPlan.properties?.schema?.const === 'swir.driver-plan/0.1', 'driver plan schema ID mismatch');
assert(driverPlan.properties?.mode?.const === 'preview', 'driver plan must remain preview-only');
assert(driverPlan.properties?.readOnly?.const === true, 'driver plan must remain read-only');
assert(driverPlan.properties?.autoExecutable?.const === false, 'driver plan must not be directly executable');
assert(driverPlan.properties?.host, 'driver plan must carry non-privileged host facts');
assert(driverCenter.$schema?.includes('2020-12'), 'Driver Center report schema must use JSON Schema 2020-12');
assert(driverCenter.properties?.schema?.const === 'swir.driver-center-report/0.1', 'Driver Center report schema ID mismatch');
assert(driverCenter.properties?.mode?.const === 'diagnostics', 'Driver Center must remain diagnostics-only');
assert(driverCenter.properties?.readOnly?.const === true, 'Driver Center report must remain read-only');
assert(driverCenter.properties?.autoMutation?.const === false, 'Driver Center must not directly mutate hardware state');
assert(driverCenter.properties?.policy?.properties?.unknownHardwareMayAutoDownload?.const === false, 'Driver Center must prohibit unknown-hardware auto-download');
assert(driverCenter.properties?.policy?.properties?.windowsKernelDriversAsLinuxDrivers?.const === false, 'Driver Center must reject Windows kernel drivers as Linux drivers');
assert(providers.properties?.schema?.const === 'swir.package-provider/0.2', 'provider schema ID mismatch');
assert(providers.required?.includes('targetEditions'), 'provider manifest must declare target editions');
assert(providers.properties?.package?.properties?.nativeEntryPoint, 'provider manifest must support a native entry point');
const providerRules = JSON.stringify(providers.allOf ?? []);
assert(providerRules.includes('targetEditions') && providerRules.includes('system'), 'provider schema must define a System Edition target rule');
assert(providerRules.includes('linux-native') && providerRules.includes('windows-compat'), 'System Edition rule must allow Linux native and Windows compatibility execution');
assert(providerRules.includes('nativeEntryPoint'), 'native execution classes must require a native entry point');
assert(trust.schema === 'swir.trusted-sources/0.1', 'trusted source schema mismatch');
assert(baselineCatalog.schema === 'swir.hardware-catalog/0.1', 'baseline Hardware Catalog schema mismatch');
assert(Array.isArray(baselineCatalog.entries), 'baseline Hardware Catalog entries must be an array');

const allowedDriverClasses = new Set(['kernel-in-tree','linux-firmware','distribution-repository','fwupd-lvfs','vendor-official-repository']);
const catalogClasses = new Set(hardware.$defs.entry.properties.sources.items.properties.class.enum);
const snapshotClasses = new Set(snapshot.$defs.device.properties.catalog.properties.recommendedSources.items.properties.class.enum);
const planClasses = new Set(driverPlan.$defs.source.properties.class.enum);
const policyClasses = new Set(trust.driverSourceClasses);
assert([...catalogClasses].every(x => allowedDriverClasses.has(x)), 'hardware schema exposes unapproved driver source class');
assert([...snapshotClasses].every(x => allowedDriverClasses.has(x)), 'snapshot schema exposes unapproved driver source class');
assert([...planClasses].every(x => allowedDriverClasses.has(x)), 'driver plan schema exposes unapproved driver source class');
assert([...policyClasses].every(x => allowedDriverClasses.has(x)), 'trusted-sources exposes unapproved driver source class');
assert(allowedDriverClasses.size === policyClasses.size, 'trusted-sources driver classes must match Architecture 0.1 allowlist');
assert(snapshotClasses.size === allowedDriverClasses.size, 'snapshot driver classes must match trusted source allowlist');
assert(planClasses.size === allowedDriverClasses.size, 'driver plan source classes must match trusted source allowlist');

for (const entry of baselineCatalog.entries) {
  assert(typeof entry.id === 'string' && entry.id.length > 0, 'Hardware Catalog entry requires id');
  assert(['pci', 'usb', 'platform'].includes(entry.match?.bus), `Hardware Catalog ${entry.id} has unsupported bus`);
  assert(Array.isArray(entry.match?.ids) && entry.match.ids.length > 0, `Hardware Catalog ${entry.id} requires match IDs`);
  assert(Array.isArray(entry.sources) && entry.sources.length > 0, `Hardware Catalog ${entry.id} requires trusted sources`);
  for (const source of entry.sources) {
    assert(allowedDriverClasses.has(source.class), `Hardware Catalog ${entry.id} exposes unapproved source ${source.class}`);
    assert(typeof source.ref === 'string' && source.ref.length > 0, `Hardware Catalog ${entry.id} source requires ref`);
  }
}

const providerIds = new Set(providers.properties.provider.enum);
const reserved = new Set(trust.reservedProviders);
assert(providerIds.size === reserved.size && [...providerIds].every(x => reserved.has(x)), 'provider schema and trusted-sources provider lists diverge');
const executionClasses = new Set(providers.properties.executionClass.enum);
for (const required of ['swir-web', 'linux-native', 'windows-compat']) assert(executionClasses.has(required), `missing execution class ${required}`);

assert(trust.policy?.arbitraryDriverUrls === false, 'arbitrary driver URLs must remain disabled');
assert(trust.policy?.windowsKernelDriversAsLinuxDrivers === false, 'Windows kernel drivers must not be treated as Linux drivers');
assert(trust.policy?.signatureVerificationRequiredForRepositories === true, 'repository signature verification must stay required');
assert(trust.policy?.privilegedMutationRequiresPlan === true, 'privileged mutation must require a plan');
assert(trust.policy?.privilegedMutationRequiresJournal === true, 'privileged mutation must require a journal');
assert(trust.policy?.unknownHardwareMayAutoDownload === false, 'unknown hardware must not auto-download drivers');
const forbidden = new Set(trust.forbiddenAutomaticDriverArtifacts.map(x => x.toLowerCase()));
for (const ext of ['.exe', '.msi', '.sys']) assert(forbidden.has(ext), `missing forbidden automatic driver artifact ${ext}`);

assert(baseImageSchema.$schema?.includes('2020-12'), 'System base image profile schema must use JSON Schema 2020-12');
assert(baseImageSchema.properties?.schema?.const === 'swir.system-base-image-profile/0.1', 'System base image profile schema ID mismatch');
assert(baseImageProfile.schema === 'swir.system-base-image-profile/0.1', 'System base image profile ID mismatch');
assert(baseImageProfile.status === 'candidate', 'Debian base must remain candidate before bootloader/desktop E2E');
assert(baseImageProfile.distribution?.id === 'debian' && baseImageProfile.distribution?.majorVersion === 13 && baseImageProfile.distribution?.codename === 'trixie', 'System base must stay pinned to Debian 13 trixie');
assert(baseImageProfile.packageManager === 'apt', 'Debian System base must use apt');
assert(baseImageProfile.bootableImageClaim === false, 'direct-kernel VM E2E must not claim final bootable image completion');
assert(baseImageProfile.directKernelVmE2EClaim === true, 'System base profile must declare direct-kernel VM E2E scope');
assert(baseImageProfile.bootloaderE2EClaim === false, 'System base profile must keep bootloader E2E pending');
assert(baseImageProfile.securityPolicy?.allowUnsignedRepositories === false, 'System base must prohibit unsigned repositories');
assert(baseImageProfile.securityPolicy?.allowThirdPartyRepositories === false, 'System base must prohibit third-party repositories by default');
assert(baseImageProfile.securityPolicy?.allowRandomBinaryDrivers === false, 'System base must prohibit random binary driver downloads');
assert(baseImageProfile.securityPolicy?.windowsKernelDriversAsLinuxDrivers === false, 'System base must reject Windows kernel drivers as Linux drivers');
assert(baseImageProfile.securityPolicy?.repositorySignatureVerificationRequired === true, 'System base must require repository signatures');
const systemBaseRepoUris = new Set(baseImageProfile.repositories.map(repo => repo.uri));
assert(systemBaseRepoUris.size === 2 && systemBaseRepoUris.has('https://deb.debian.org/debian') && systemBaseRepoUris.has('https://security.debian.org/debian-security'), 'System base repositories must be exactly the approved Debian distribution/security endpoints');
for (const repo of baseImageProfile.repositories) assert(repo.signedBy === '/usr/share/keyrings/debian-archive-keyring.gpg', `System base repository ${repo.id} must use Debian archive keyring`);
assert(imageReadinessSchema.properties?.schema?.const === 'swir.system-image-readiness/0.1', 'System image readiness schema ID mismatch');
assert(imageReadinessSchema.properties?.summary?.required?.includes('sessionReady'), 'System image readiness must expose required session readiness');

const serviceSource = fs.readFileSync(path.join(ROOT, 'hardware', 'hardware-service.mjs'), 'utf8');
const resolverSource = fs.readFileSync(path.join(ROOT, 'hardware', 'driver-resolver.mjs'), 'utf8');
const driverCenterSource = fs.readFileSync(path.join(ROOT, 'hardware', 'driver-center-service.mjs'), 'utf8');
assert(serviceSource.includes("readOnly: true"), 'Hardware Service must explicitly emit readOnly=true');
assert(serviceSource.includes("swir.hardware-snapshot/0.2"), 'Hardware Service must emit snapshot contract 0.2');
assert(serviceSource.includes('detectLinuxHostEnvironment'), 'Hardware Service must expose host environment detection');
assert(serviceSource.includes('modalias'), 'Hardware Service must preserve modalias diagnostics');
for (const forbiddenCall of ['execSync(', 'spawnSync(', 'execFileSync(', 'spawn(', 'exec(']) {
  assert(!serviceSource.includes(forbiddenCall), `Hardware Service must not execute system commands: ${forbiddenCall}`);
  assert(!resolverSource.includes(forbiddenCall), `Driver resolver must not execute system commands: ${forbiddenCall}`);
  assert(!driverCenterSource.includes(forbiddenCall), `Driver Center diagnostics must not execute system commands: ${forbiddenCall}`);
}
assert(resolverSource.includes("autoExecutable: false"), 'Driver resolver must explicitly disable direct execution');
assert(resolverSource.includes('fwupdAvailable'), 'Driver resolver must account for fwupd availability');
assert(resolverSource.includes('packageManagers'), 'Driver resolver must account for package manager availability');
assert(driverCenterSource.includes("autoMutation: false"), 'Driver Center diagnostics must explicitly disable direct mutations');
assert(driverCenterSource.includes('ARBITRARY_DRIVER_URL'), 'Driver Center must reject arbitrary driver URLs');
assert(driverCenterSource.includes('FORBIDDEN_DRIVER_ARTIFACT'), 'Driver Center must reject forbidden binary driver artifacts');
assert(driverCenterSource.includes('VENDOR_REPOSITORY_ID_REQUIRED'), 'Driver Center must bind vendor exceptions to explicit repository IDs');

const doc = fs.readFileSync(path.join(ROOT, 'SWIR-SYSTEM-EDITION-ARCHITECTURE-0.1.md'), 'utf8');
for (const phrase of ['Wine / Proton', 'Hardware Service', 'SWIR Driver Center', 'fwupd', 'linux-firmware']) assert(doc.includes(phrase), `architecture document missing required concept: ${phrase}`);

console.log('SWIR System Edition contract validation: OK');
console.log(`Driver source classes: ${[...policyClasses].join(', ')}`);
console.log(`Reserved providers: ${[...providerIds].join(', ')}`);
console.log(`Hardware Catalog entries: ${baselineCatalog.entries.length}`);
console.log(`System base candidate: ${baseImageProfile.distribution.id}-${baseImageProfile.distribution.majorVersion}/${baseImageProfile.distribution.codename} direct-kernel-vm-e2e`);
console.log('Package provider: 0.2 with native-only System Edition execution');
console.log('Hardware snapshot: 0.2 read-only host diagnostics');
console.log('Driver plan mode: preview/read-only/non-executable');
console.log('Driver Center report: 0.1 diagnostics/read-only/non-mutating');
