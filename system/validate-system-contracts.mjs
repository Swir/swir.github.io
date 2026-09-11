import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

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
const providers = readJson('package-provider.schema.json');
const trust = readJson('trusted-sources.json');
const baselineCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'hardware', 'hardware-catalog.json'), 'utf8'));

assert(hardware.$schema?.includes('2020-12'), 'hardware schema must use JSON Schema 2020-12');
assert(hardware.properties?.schema?.const === 'swir.hardware-catalog/0.1', 'hardware schema ID mismatch');
assert(snapshot.$schema?.includes('2020-12'), 'snapshot schema must use JSON Schema 2020-12');
assert(snapshot.properties?.schema?.const === 'swir.hardware-snapshot/0.1', 'snapshot schema ID mismatch');
assert(snapshot.properties?.host?.properties?.readOnly?.const === true, 'Hardware Service snapshot must remain read-only');
assert(driverPlan.$schema?.includes('2020-12'), 'driver plan schema must use JSON Schema 2020-12');
assert(driverPlan.properties?.schema?.const === 'swir.driver-plan/0.1', 'driver plan schema ID mismatch');
assert(driverPlan.properties?.mode?.const === 'preview', 'driver plan must remain preview-only');
assert(driverPlan.properties?.readOnly?.const === true, 'driver plan must remain read-only');
assert(driverPlan.properties?.autoExecutable?.const === false, 'driver plan must not be directly executable');
assert(providers.properties?.schema?.const === 'swir.package-provider/0.1', 'provider schema ID mismatch');
assert(trust.schema === 'swir.trusted-sources/0.1', 'trusted source schema mismatch');
assert(baselineCatalog.schema === 'swir.hardware-catalog/0.1', 'baseline Hardware Catalog schema mismatch');
assert(Array.isArray(baselineCatalog.entries), 'baseline Hardware Catalog entries must be an array');

const allowedDriverClasses = new Set([
  'kernel-in-tree',
  'linux-firmware',
  'distribution-repository',
  'fwupd-lvfs',
  'vendor-official-repository'
]);
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
for (const required of ['swir-web', 'linux-native', 'windows-compat']) {
  assert(executionClasses.has(required), `missing execution class ${required}`);
}

assert(trust.policy?.arbitraryDriverUrls === false, 'arbitrary driver URLs must remain disabled');
assert(trust.policy?.windowsKernelDriversAsLinuxDrivers === false, 'Windows kernel drivers must not be treated as Linux drivers');
assert(trust.policy?.signatureVerificationRequiredForRepositories === true, 'repository signature verification must stay required');
assert(trust.policy?.privilegedMutationRequiresPlan === true, 'privileged mutation must require a plan');
assert(trust.policy?.privilegedMutationRequiresJournal === true, 'privileged mutation must require a journal');
assert(trust.policy?.unknownHardwareMayAutoDownload === false, 'unknown hardware must not auto-download drivers');

const forbidden = new Set(trust.forbiddenAutomaticDriverArtifacts.map(x => x.toLowerCase()));
for (const ext of ['.exe', '.msi', '.sys']) {
  assert(forbidden.has(ext), `missing forbidden automatic driver artifact ${ext}`);
}

const serviceSource = fs.readFileSync(path.join(ROOT, 'hardware', 'hardware-service.mjs'), 'utf8');
const resolverSource = fs.readFileSync(path.join(ROOT, 'hardware', 'driver-resolver.mjs'), 'utf8');
assert(serviceSource.includes("readOnly: true"), 'Hardware Service must explicitly emit readOnly=true');
assert(!serviceSource.includes('execSync(') && !serviceSource.includes('spawnSync('), 'Hardware Service 0.1 must not execute system commands');
assert(resolverSource.includes("autoExecutable: false"), 'Driver resolver must explicitly disable direct execution');
for (const forbiddenCall of ['execSync(', 'spawnSync(', 'execFileSync(', 'spawn(']) {
  assert(!resolverSource.includes(forbiddenCall), `Driver resolver must not execute system commands: ${forbiddenCall}`);
}

const doc = fs.readFileSync(path.join(ROOT, 'SWIR-SYSTEM-EDITION-ARCHITECTURE-0.1.md'), 'utf8');
for (const phrase of ['Wine / Proton', 'Hardware Service', 'SWIR Driver Center', 'fwupd', 'linux-firmware']) {
  assert(doc.includes(phrase), `architecture document missing required concept: ${phrase}`);
}

console.log('SWIR System Edition contract validation: OK');
console.log(`Driver source classes: ${[...policyClasses].join(', ')}`);
console.log(`Reserved providers: ${[...providerIds].join(', ')}`);
console.log(`Hardware Catalog entries: ${baselineCatalog.entries.length}`);
console.log('Driver plan mode: preview/read-only/non-executable');
