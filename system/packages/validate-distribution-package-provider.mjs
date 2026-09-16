import fs from 'node:fs';
import path from 'node:path';

const packageDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const systemDir = path.dirname(packageDir);
const contractsDir = path.join(systemDir, 'contracts');
const readJson = file => JSON.parse(fs.readFileSync(path.join(contractsDir, file), 'utf8'));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const plan = readJson('distribution-package-plan.schema.json');
const providerManifest = readJson('package-provider.schema.json');
const trust = readJson('trusted-sources.json');
const source = fs.readFileSync(path.join(packageDir, 'distribution-package-provider.mjs'), 'utf8');

assert(plan.$schema?.includes('2020-12'), 'distribution package plan must use JSON Schema 2020-12');
assert(plan.properties?.schema?.const === 'swir.system-package-plan/0.1', 'distribution package plan schema mismatch');
assert(plan.properties?.mode?.const === 'preview', 'distribution package plan must remain preview-only');
assert(plan.properties?.readOnly?.const === true, 'distribution package plan must remain read-only');
assert(plan.properties?.autoExecutable?.const === false, 'distribution package plan must not be directly executable');
assert(plan.properties?.provider?.const === 'swir.package.system', 'distribution package provider mismatch');
assert(plan.properties?.source?.properties?.class?.const === 'distribution-repository', 'distribution package source class mismatch');
assert(plan.properties?.trust?.properties?.signatureVerificationRequired?.const === true, 'distribution package plan must require repository signature verification');
assert(plan.properties?.trust?.properties?.arbitraryRepositoryUrlAllowed?.const === false, 'distribution package plan must reject arbitrary repository URLs');
assert(plan.properties?.transaction?.properties?.requiresPrivilege?.const === true, 'package mutations must require privilege');
assert(plan.properties?.transaction?.properties?.journalRequired?.const === true, 'package mutations must require a journal');

assert(providerManifest.properties?.provider?.enum?.includes('swir.package.system'), 'package provider manifest must reserve swir.package.system');
assert(providerManifest.properties?.executionClass?.enum?.includes('linux-native'), 'package provider manifest must expose linux-native');
assert(trust.packageSourceClasses?.includes('distribution-repository'), 'trusted sources must allow distribution repositories');
assert(trust.policy?.signatureVerificationRequiredForRepositories === true, 'trusted sources must require repository signatures');
assert(trust.policy?.privilegedMutationRequiresPlan === true, 'trusted sources must require mutation plans');
assert(trust.policy?.privilegedMutationRequiresJournal === true, 'trusted sources must require mutation journals');

for (const phrase of [
  "sourceClass !== 'distribution-repository'",
  'distribution repository signatures must be required',
  'distribution repository is not allowlisted',
  'autoExecutable: false',
  'PACKAGE_MUTATION_BROKER_REQUIRED'
]) assert(source.includes(phrase), `distribution provider missing fail-closed boundary: ${phrase}`);
for (const forbidden of ['node:child_process', 'exec(', 'execSync(', 'spawn(', 'spawnSync(', 'shell: true']) {
  assert(!source.includes(forbidden), `preview distribution provider must not execute package manager commands: ${forbidden}`);
}

console.log('SWIR distribution package provider contract validation: OK');
console.log('Provider: swir.package.system / source: distribution-repository');
console.log('Mode: preview/read-only/non-executable with journaled privileged mutation required');
