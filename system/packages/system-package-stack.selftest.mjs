import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DistributionPackageProvider } from './distribution-package-provider.mjs';
import { SystemPackageTransactionService } from './package-transaction-service.mjs';
import { SystemPackageStack, SystemPackageStackPolicy } from './system-package-stack.mjs';
import { SystemPackageSecurityBoundary } from '../security/system-package-security-boundary.mjs';
import { PolkitSystemAuthorizationBroker } from '../security/polkit-authorization-broker.mjs';
import { DistributionRepositoryTrustVerifier } from '../security/distribution-repository-trust.mjs';

const host = {
  distribution: { id: 'debian', versionId: '13', prettyName: 'Debian test host', family: 'debian' },
  capabilities: { packageManagers: ['apt'] }
};
const repositoryPolicy = {
  schema: 'swir.system-repository-trust-policy/0.1',
  defaultRepositoryId: 'debian-main',
  repositories: [{
    id: 'debian-main', manager: 'apt', nativeId: 'deb.debian.org/debian', sourceClass: 'distribution-repository',
    distributions: ['debian'], signatureVerification: 'native-required', allowInsecure: false, enabled: true
  }]
};
const manifest = {
  schema: 'swir.package-provider/0.2',
  id: 'org.example.editor',
  targetEditions: ['system'],
  executionClass: 'linux-native',
  provider: 'swir.package.system',
  package: { name: 'Example Editor', sourceRef: 'example-editor', nativeEntryPoint: '/usr/bin/example-editor' },
  trust: { sourceClass: 'distribution-repository', repositoryId: 'debian-main', signatureRequired: true }
};

const authCalls = [];
const authorizationBroker = new PolkitSystemAuthorizationBroker({
  processProbe: () => ({ pid: 101, uid: 1000, startTime: '4444' }),
  fileProbe: () => ({ isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100755 }),
  runner: (command, args, options) => {
    authCalls.push({ command, args, options });
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  },
  grantIdFactory: () => 'grant:stack:0001',
  clock: () => '2026-09-16T21:40:00.000Z'
});
const trustCalls = [];
const trustVerifier = new DistributionRepositoryTrustVerifier({
  policy: repositoryPolicy,
  fileProbe: () => ({ isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100755 }),
  runner: (command, args, options) => {
    trustCalls.push({ command, args, options });
    return { exitCode: 0, signal: null, stdout: 'example-editor:\n Candidate: 1.0\n 500 http://deb.debian.org/debian stable/main amd64 Packages\n', stderr: '' };
  },
  proofIdFactory: () => 'proof:stack:0001',
  clock: () => '2026-09-16T21:40:00.000Z'
});
const securityBoundary = new SystemPackageSecurityBoundary({ repositoryPolicy, authorizationBroker, trustVerifier });
const provider = new DistributionPackageProvider({ host, allowlistedRepositories: securityBoundary.allowlistedRepositories });

const executionCalls = [];
const executor = {
  async execute(request) {
    executionCalls.push(JSON.parse(JSON.stringify(request)));
    return { schema: 'swir.package-executor-result/0.1', ok: true, transactionId: request.transactionId, manager: request.manager, operation: request.operation, exitCode: 0, signal: null, stdout: '', stderr: '' };
  }
};
const snapshotProvider = {
  async capture({ manager, packageName, packageId }) {
    return { schema: 'swir.package-snapshot/0.1', capturedAt: '2026-09-16T21:40:00.000Z', packageId, manager, packageName, installed: false, version: null, query: { source: 'dpkg-query', exitCode: 1, signal: null } };
  }
};
const healthVerifier = {
  async verify({ packageId, packageName }) {
    return { schema: 'swir.package-health/0.1', packageId, packageName, healthy: true, checks: [{ id: 'entry', ok: true }] };
  }
};

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-system-stack-'));
try {
  const transactionService = new SystemPackageTransactionService({
    journalDirectory: path.join(temp, 'journals'),
    executor,
    authorizationBroker,
    trustVerifier,
    snapshotProvider,
    healthVerifier,
    allowlistedRepositories: securityBoundary.allowlistedRepositories,
    idFactory: () => 'stack-test-0001',
    clock: () => '2026-09-16T21:40:00.000Z'
  });
  const stack = new SystemPackageStack({ provider, transactionService, securityBoundary });

  assert.equal(SystemPackageStackPolicy.productionDependencyInjection, false);
  assert.equal(stack.describe().directCallerPlanExecution, false);
  assert.deepEqual(stack.describe().allowlistedRepositories, ['debian-main']);
  const plan = stack.plan('install', manifest);
  assert.deepEqual(plan.commandPreview, ['apt-get', 'install', '--', 'example-editor']);
  assert.equal(plan.source.repositoryId, 'debian-main');

  const record = await stack.execute('install', manifest, { actorId: 'uid:1000' });
  assert.equal(record.state, 'committed');
  assert.equal(record.plan.package.id, 'org.example.editor');
  assert.equal(executionCalls.length, 1);
  assert.equal(executionCalls[0].manager, 'apt');
  assert.deepEqual(executionCalls[0].command, ['apt-get', 'install', '--', 'example-editor']);
  assert.equal(authCalls.length, 1);
  assert.ok(authCalls[0].args.includes('org.swir.system.packages.mutate'));
  assert.equal(trustCalls.length, 1);
  assert.equal(trustCalls[0].command, '/usr/bin/apt-cache');

  assert.throws(() => stack.plan('install', { ...manifest, trust: { ...manifest.trust, repositoryId: 'evil' } }), /not allowlisted/);
  assert.throws(() => stack.plan('execute-shell', manifest), error => error?.code === 'UNSUPPORTED_OPERATION');
  const pending = await stack.recoverPending({ actorId: 'uid:1000' });
  assert.deepEqual(pending, []);
  console.log('SWIR System package stack integration self-test OK');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
