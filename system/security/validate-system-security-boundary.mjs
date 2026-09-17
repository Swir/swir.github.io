import fs from 'node:fs';
import path from 'node:path';
import { validateRepositoryTrustPolicy } from './distribution-repository-trust.mjs';
import { SystemPolkitAuthorizationPolicy } from './polkit-authorization-broker.mjs';
import { SystemNetworkPolkitPolicy } from './polkit-network-authorization-broker.mjs';
import { SystemFirmwarePolkitPolicy } from './polkit-firmware-authorization-broker.mjs';

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

function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} contains duplicate action ${value}`);
    seen.add(value);
  }
  return seen;
}

function extractActions(xml) {
  return [...xml.matchAll(/<action\s+id="([^"]+)"/g)].map(match => match[1]);
}

function validatePolicyXml({ rel, expectedActions, requireActive }) {
  const xml = read(rel);
  const actual = unique(extractActions(xml), `${rel} policy`);
  const expected = unique(expectedActions, `${rel} expected action set`);
  if (actual.size !== expected.size || [...expected].some(action => !actual.has(action))) {
    throw new Error(`${rel} action set does not exactly match its broker policy export`);
  }
  if (/<allow_any>\s*yes\s*<\/allow_any>/i.test(xml)) throw new Error(`${rel} must never authorize allow_any=yes`);
  if (/<allow_inactive>\s*yes\s*<\/allow_inactive>/i.test(xml)) throw new Error(`${rel} must never authorize inactive sessions without authentication`);
  if (/<allow_active>\s*yes\s*<\/allow_active>/i.test(xml)) throw new Error(`${rel} must never authorize active sessions without authentication`);
  if (!xml.includes('<annotate key="org.freedesktop.policykit.owner">root</annotate>')) {
    throw new Error(`${rel} must retain root PolicyKit ownership annotation`);
  }
  if (requireActive && !requireActive.some(value => xml.includes(`<allow_active>${value}</allow_active>`))) {
    throw new Error(`${rel} does not contain the required authenticated active-session policy`);
  }
  return actual;
}

const packageActions = Object.values(SystemPolkitAuthorizationPolicy.scopes);
const networkActions = Object.values(SystemNetworkPolkitPolicy.actions);
const firmwareActions = Object.values(SystemFirmwarePolkitPolicy.actions);

const policySets = [
  validatePolicyXml({
    rel: 'system/security/org.swir.system.packages.policy',
    expectedActions: packageActions,
    requireActive: ['auth_admin_keep', 'auth_admin']
  }),
  validatePolicyXml({
    rel: 'system/security/org.swir.system.network.policy',
    expectedActions: networkActions,
    requireActive: ['auth_self_keep', 'auth_self']
  }),
  validatePolicyXml({
    rel: 'system/security/org.swir.system.firmware.policy',
    expectedActions: firmwareActions,
    requireActive: ['auth_admin_keep', 'auth_admin']
  })
];

const allNativeActions = [...policySets].flatMap(set => [...set]);
unique(allNativeActions, 'System Edition native Polkit action registry');
for (const action of allNativeActions) {
  if (!/^org\.swir\.system\.[a-z0-9.-]+$/.test(action)) throw new Error(`Unexpected non-SWIR native action id: ${action}`);
}

if (SystemPolkitAuthorizationPolicy.shellExecution !== false || SystemNetworkPolkitPolicy.shellExecution !== false || SystemFirmwarePolkitPolicy.shellExecution !== false) {
  throw new Error('All System Edition Polkit brokers must keep shell execution disabled.');
}
if (SystemPolkitAuthorizationPolicy.planDigestBinding !== true || SystemNetworkPolkitPolicy.planDigestBinding !== true || SystemFirmwarePolkitPolicy.planDigestBinding !== true) {
  throw new Error('All mutation brokers must bind authorization to an exact plan digest.');
}
if (SystemNetworkPolkitPolicy.arbitraryNmcliArguments !== false) throw new Error('Network authorization must not expose arbitrary nmcli arguments.');
if (SystemFirmwarePolkitPolicy.arbitraryFwupdArguments !== false) throw new Error('Firmware authorization must not expose arbitrary fwupd arguments.');

const composition = read('system/security/system-package-security-boundary.mjs');
for (const required of ['PolkitSystemAuthorizationBroker', 'DistributionRepositoryTrustVerifier', 'loadRepositoryTrustPolicy', 'allowlistedRepositories']) {
  if (!composition.includes(required)) throw new Error(`Security boundary composition is missing ${required}`);
}

console.log(`SWIR System security boundary validated: packageActions=${packageActions.length}, networkActions=${networkActions.length}, firmwareActions=${firmwareActions.length}, repositories=${examplePolicy.repositories.length}, contracts=${contracts.length}`);
