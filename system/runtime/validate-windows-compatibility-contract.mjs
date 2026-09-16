import fs from 'node:fs';
import path from 'node:path';

const runtimeDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const systemDir = path.dirname(runtimeDir);
const contractsDir = path.join(systemDir, 'contracts');

function readJson(file) {
  const full = path.join(contractsDir, file);
  try { return JSON.parse(fs.readFileSync(full, 'utf8')); }
  catch (error) { throw new Error(`${file}: invalid JSON: ${error.message}`); }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const launch = readJson('windows-compat-launch.schema.json');
const providers = readJson('package-provider.schema.json');
const trust = readJson('trusted-sources.json');
const source = fs.readFileSync(path.join(runtimeDir, 'windows-compatibility-service.mjs'), 'utf8');
const docs = fs.readFileSync(path.join(systemDir, 'SWIR-WINDOWS-COMPATIBILITY-0.1.md'), 'utf8');

assert(launch.$schema?.includes('2020-12'), 'compatibility launch schema must use JSON Schema 2020-12');
assert(launch.properties?.schema?.const === 'swir.windows-compat-launch/0.1', 'compatibility launch schema ID mismatch');
assert(launch.properties?.mode?.const === 'guarded', 'compatibility launch plan must stay guarded');
assert(launch.properties?.brokerRequired?.const === true, 'compatibility launch must require the broker');
assert(launch.properties?.shell?.const === false, 'compatibility launch must disable shell execution');
assert(launch.properties?.executionClass?.const === 'windows-compat', 'compatibility execution class mismatch');
assert(launch.properties?.prefixPolicy?.const === 'per-app', 'compatibility contract must default to per-app prefixes');
assert(launch.properties?.trust?.properties?.verified?.const === true, 'compatibility launch must require verified trust');
assert(launch.properties?.trust?.properties?.signatureRequired?.const === true, 'compatibility launch must require package signatures');

const contractProviders = new Set(launch.properties?.provider?.enum || []);
const expectedProviders = new Set(['swir.compat.wine', 'swir.compat.proton']);
assert(contractProviders.size === expectedProviders.size && [...expectedProviders].every(value => contractProviders.has(value)), 'compatibility launch provider allowlist mismatch');

const reserved = new Set(trust.reservedProviders || []);
for (const provider of expectedProviders) assert(reserved.has(provider), `trusted sources does not reserve ${provider}`);
const providerEnum = new Set(providers.properties?.provider?.enum || []);
for (const provider of expectedProviders) assert(providerEnum.has(provider), `package provider schema does not expose ${provider}`);
const providerRules = JSON.stringify(providers.allOf || []);
assert(providerRules.includes('windows-compat'), 'package provider schema must define windows-compat rules');
assert(providerRules.includes('swir.compat.wine') && providerRules.includes('swir.compat.proton'), 'package provider schema must bind compatibility providers');

for (const phrase of [
  "prefixPolicy !== 'per-app'",
  'package trust must be verified before compatibility launch',
  'Windows compatibility package must require signature verification',
  'Windows entry point is outside its managed prefix',
  'FORBIDDEN_WINDOWS_ARTIFACT',
  'WINEPREFIX',
  'STEAM_COMPAT_DATA_PATH',
  'shell: false'
]) assert(source.includes(phrase), `compatibility service missing security boundary: ${phrase}`);

for (const forbiddenCall of ['execSync(', 'execFileSync(', 'spawnSync(', 'shell: true']) {
  assert(!source.includes(forbiddenCall), `compatibility service must not use unsafe execution primitive: ${forbiddenCall}`);
}

assert(source.includes("new Set(['.exe', '.com'])"), 'compatibility launcher must restrict direct Windows user-app artifact types');
assert(source.includes("new Set(['SIGTERM', 'SIGINT', 'SIGKILL'])"), 'compatibility service must keep a bounded stop-signal allowlist');
assert(source.includes("DEFAULT_PREFIX_ROOT = '/var/lib/swir/compat/prefixes'"), 'compatibility prefixes must have a managed default root');

for (const phrase of [
  'Wine/Proton runtime is administrator-provisioned',
  'per-application managed prefix',
  'does not make the System Edition roadmap item complete',
  'Windows kernel drivers remain unsupported'
]) assert(docs.includes(phrase), `compatibility documentation missing required statement: ${phrase}`);

console.log('SWIR Windows compatibility contract validation: OK');
console.log(`Providers: ${[...contractProviders].join(', ')}`);
console.log('Prefix policy: per-app managed prefixes only');
console.log('Execution: brokered, shell=false, signature/trust required');
