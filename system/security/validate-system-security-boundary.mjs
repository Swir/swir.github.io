import fs from 'node:fs';
import path from 'node:path';
import { validateRepositoryTrustPolicy } from './distribution-repository-trust.mjs';
import { SystemPolkitAuthorizationPolicy } from './polkit-authorization-broker.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const parse = rel => JSON.parse(read(rel));

const contracts = [
  'system/contracts/system-authorization-grant.schema.json',
  'system/contracts/repository-trust-policy.schema.json',
  'system/contracts/repository-trust-proof.schema.json'
];
for (const rel of contracts) parse(rel);

const examplePolicy = parse('system/security/repository-trust-policy.example.json');
validateRepositoryTrustPolicy(examplePolicy);
if (!examplePolicy.repositories.every(repo => repo.nativeId.includes('example.invalid'))) {
  throw new Error('Repository policy example must stay non-routable/fail-closed; use example.invalid native IDs only.');
}

const policyXml = read('system/security/org.swir.system.packages.policy');
for (const action of Object.values(SystemPolkitAuthorizationPolicy.scopes)) {
  if (!policyXml.includes(`action id="${action}"`)) throw new Error(`Polkit policy is missing action ${action}`);
}
if (/<allow_any>\s*yes\s*<\/allow_any>/i.test(policyXml)) throw new Error('Polkit policy must never authorize allow_any=yes');
if (/<allow_inactive>\s*yes\s*<\/allow_inactive>/i.test(policyXml)) throw new Error('Polkit policy must never authorize inactive sessions without authentication');
if (!policyXml.includes('<allow_active>auth_admin_keep</allow_active>')) throw new Error('Package mutation action must require administrator authentication for active sessions.');

const composition = read('system/security/system-package-security-boundary.mjs');
for (const required of ['PolkitSystemAuthorizationBroker', 'DistributionRepositoryTrustVerifier', 'loadRepositoryTrustPolicy', 'allowlistedRepositories']) {
  if (!composition.includes(required)) throw new Error(`Security boundary composition is missing ${required}`);
}

console.log(`SWIR System security boundary validated: scopes=${Object.keys(SystemPolkitAuthorizationPolicy.scopes).length}, repositories=${examplePolicy.repositories.length}, contracts=${contracts.length}`);
