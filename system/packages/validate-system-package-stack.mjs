import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const source = fs.readFileSync(path.join(root, 'system/packages/system-package-stack.mjs'), 'utf8');
const required = [
  'DistributionPackageProvider',
  'SystemPackageTransactionService',
  'GuardedPkexecPackageExecutor',
  'DistributionPackageSnapshotProvider',
  'NativePackageHealthVerifier',
  'createSystemPackageSecurityBoundary',
  "directCallerPlanExecution: false",
  "productionDependencyInjection: false",
  "journalDirectory = '/var/lib/swir/package-transactions'",
  "repositoryPolicyPath = '/etc/swir/repository-trust-policy.json'"
];
for (const token of required) if (!source.includes(token)) throw new Error(`System package stack is missing production invariant: ${token}`);
if (/createSystemPackageStack\s*\([\s\S]*?runner\s*=/.test(source)) throw new Error('Production stack factory must not expose runner dependency injection.');
if (/createSystemPackageStack\s*\([\s\S]*?executor\s*=/.test(source)) throw new Error('Production stack factory must not expose executor dependency injection.');
if (/createSystemPackageStack\s*\([\s\S]*?authorizationBroker\s*=/.test(source)) throw new Error('Production stack factory must not expose authorization broker dependency injection.');
console.log('SWIR System package stack production assembly validation OK');
