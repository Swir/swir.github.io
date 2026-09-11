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
const providers = readJson('package-provider.schema.json');
const trust = readJson('trusted-sources.json');

assert(hardware.$schema?.includes('2020-12'), 'hardware schema must use JSON Schema 2020-12');
assert(hardware.properties?.schema?.const === 'swir.hardware-catalog/0.1', 'hardware schema ID mismatch');
assert(providers.properties?.schema?.const === 'swir.package-provider/0.1', 'provider schema ID mismatch');
assert(trust.schema === 'swir.trusted-sources/0.1', 'trusted source schema mismatch');

const allowedDriverClasses = new Set([
  'kernel-in-tree',
  'linux-firmware',
  'distribution-repository',
  'fwupd-lvfs',
  'vendor-official-repository'
]);
const catalogClasses = new Set(hardware.$defs.entry.properties.sources.items.properties.class.enum);
const policyClasses = new Set(trust.driverSourceClasses);
assert([...catalogClasses].every(x => allowedDriverClasses.has(x)), 'hardware schema exposes unapproved driver source class');
assert([...policyClasses].every(x => allowedDriverClasses.has(x)), 'trusted-sources exposes unapproved driver source class');
assert(allowedDriverClasses.size === policyClasses.size, 'trusted-sources driver classes must match Architecture 0.1 allowlist');

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

const doc = fs.readFileSync(path.join(ROOT, 'SWIR-SYSTEM-EDITION-ARCHITECTURE-0.1.md'), 'utf8');
for (const phrase of ['Wine / Proton', 'Hardware Service', 'SWIR Driver Center', 'fwupd', 'linux-firmware']) {
  assert(doc.includes(phrase), `architecture document missing required concept: ${phrase}`);
}

console.log('SWIR System Edition contract validation: OK');
console.log(`Driver source classes: ${[...policyClasses].join(', ')}`);
console.log(`Reserved providers: ${[...providerIds].join(', ')}`);
