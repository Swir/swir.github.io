import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SystemPackageTransactionPolicy,
  SystemPackageTransactionService,
  digestPackagePlan,
  validateSystemPackagePlan
} from './package-transaction-service.mjs';

function aptPlan(overrides = {}) {
  const base = {
    schema: 'swir.system-package-plan/0.1',
    mode: 'preview',
    readOnly: true,
    autoExecutable: false,
    provider: 'swir.package.system',
    executionClass: 'linux-native',
    operation: 'install',
    package: { id: 'org.example.editor', sourceRef: 'example-editor', nativeEntryPoint: '/usr/bin/example-editor' },
    host: {
      distribution: { id: 'ubuntu', family: 'debian', versionId: '24.04' },
      packageManager: 'apt',
      availablePackageManagers: ['apt']
    },
    source: { class: 'distribution-repository', repositoryId: 'ubuntu-main' },
    trust: { signatureVerificationRequired: true, arbitraryRepositoryUrlAllowed: false },
    transaction: {
      requiresPrivilege: true,
      journalRequired: true,
      healthCheckRequired: true,
      rollback: { supported: false, mechanism: null, note: 'version-aware rollback unavailable' }
    },
    commandPreview: ['apt-get', 'install', '--', 'example-editor']
  };
  return { ...base, ...overrides };
}

function rpmOstreePlan() {
  return {
    ...aptPlan(),
    package: { id: 'org.example.editor', sourceRef: 'example-editor', nativeEntryPoint: '/usr/bin/example-editor' },
    host: {
      distribution: { id: 'fedora', family: 'fedora', versionId: '42' },
      packageManager: 'rpm-ostree',
      availablePackageManagers: ['rpm-ostree', 'dnf']
    },
    source: { class: 'distribution-repository', repositoryId: 'fedora-base' },
    transaction: {
      requiresPrivilege: true,
      journalRequired: true,
      healthCheckRequired: true,
      rollback: { supported: true, mechanism: 'deployment-rollback', note: 'deployment rollback supported' }
    },
    commandPreview: ['rpm-ostree', 'install', '--', 'example-editor']
  };
}

function createDependencies({ healthy = true, trustVerified = true, authorization = true, executeFailure = null } = {}) {
  const events = [];
  return {
    events,
    trustVerifier: {
      async verifyRepository(input) {
        events.push(['trust', input.repositoryId]);
        return { verified: trustVerified, proofId: trustVerified ? 'repo-proof-1' : null };
      }
    },
    authorizationBroker: {
      async authorize(input) {
        events.push(['authorize', input.scope]);
        return authorization
          ? { authorized: true, grantId: `grant-${input.scope}`, actorId: 'user:1000' }
          : { authorized: false };
      }
    },
    snapshotProvider: {
      async capture(input) {
        events.push(['snapshot', input.manager, input.packageName]);
        return { schema: 'swir.package-snapshot/0.1', installed: false, version: null };
      }
    },
    executor: {
      async execute(input) {
        events.push(['execute', input.operation, [...input.command]]);
        if (executeFailure && input.operation !== 'rollback') throw Object.assign(new Error(executeFailure), { code: 'EXECUTION_FAILED' });
        return { schema: 'swir.package-executor-result/0.1', ok: true, exitCode: 0, operation: input.operation };
      }
    },
    healthVerifier: {
      async verify(input) {
        events.push(['health', input.packageName]);
        return { healthy, checks: [{ id: 'entry-point', ok: healthy }] };
      }
    }
  };
}

function makeService(root, deps, allowlistedRepositories, id = 'tx-selftest-0001') {
  let tick = 0;
  return new SystemPackageTransactionService({
    journalDirectory: root,
    executor: deps.executor,
    authorizationBroker: deps.authorizationBroker,
    trustVerifier: deps.trustVerifier,
    snapshotProvider: deps.snapshotProvider,
    healthVerifier: deps.healthVerifier,
    allowlistedRepositories,
    idFactory: () => id,
    clock: () => `2026-09-16T20:00:${String(tick++).padStart(2, '0')}.000Z`
  });
}

assert.equal(SystemPackageTransactionPolicy.shellExecution, false);
assert.equal(SystemPackageTransactionPolicy.durableJournalRequiredBeforeMutation, true);
assert.deepEqual(SystemPackageTransactionPolicy.automaticRollbackManagers, ['rpm-ostree']);
assert.match(digestPackagePlan(aptPlan()), /^[a-f0-9]{64}$/);

const valid = validateSystemPackagePlan(aptPlan(), { allowlistedRepositories: ['ubuntu-main'] });
assert.equal(valid.manager, 'apt');
assert.deepEqual(valid.command, ['apt-get', 'install', '--', 'example-editor']);
assert.throws(() => validateSystemPackagePlan(aptPlan(), { allowlistedRepositories: ['other'] }), /not allowlisted/);
assert.throws(() => validateSystemPackagePlan({ ...aptPlan(), commandPreview: ['sh', '-c', 'id'] }, { allowlistedRepositories: ['ubuntu-main'] }), /does not match/);
assert.throws(() => validateSystemPackagePlan({ ...aptPlan(), package: { ...aptPlan().package, sourceRef: 'x;id' } }, { allowlistedRepositories: ['ubuntu-main'] }), /invalid package/);
assert.throws(() => validateSystemPackagePlan({ ...aptPlan(), trust: { signatureVerificationRequired: false, arbitraryRepositoryUrlAllowed: false } }, { allowlistedRepositories: ['ubuntu-main'] }), /signature verification/);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-pkg-tx-'));
try {
  const successDeps = createDependencies();
  const successDir = path.join(tempRoot, 'success');
  const success = makeService(successDir, successDeps, ['ubuntu-main']);
  const committed = await success.execute(aptPlan(), { reason: 'self-test' });
  assert.equal(committed.state, 'committed');
  assert.equal(committed.authorization.actorId, 'user:1000');
  assert.equal(committed.trust.verified, true);
  assert.equal(committed.health.healthy, true);
  assert.deepEqual(successDeps.events.map(event => event[0]), ['trust', 'authorize', 'snapshot', 'execute', 'health']);
  const stored = success.readJournal('tx-selftest-0001');
  assert.equal(stored.state, 'committed');
  assert.equal(stored.planDigest, digestPackagePlan(stored.plan));
  assert.deepEqual(stored.history.map(event => event.state), ['prepared', 'mutating', 'verifying', 'committed']);
  assert.equal(fs.statSync(path.join(successDir, 'tx-selftest-0001.json')).mode & 0o077, 0);

  const deniedDeps = createDependencies({ authorization: false });
  const deniedDir = path.join(tempRoot, 'denied');
  const denied = makeService(deniedDir, deniedDeps, ['ubuntu-main'], 'tx-selftest-0002');
  await assert.rejects(() => denied.execute(aptPlan()), error => error?.code === 'AUTHORIZATION_DENIED');
  assert.deepEqual(deniedDeps.events.map(event => event[0]), ['trust', 'authorize']);
  assert.equal(fs.readdirSync(deniedDir).length, 0);

  const trustDeps = createDependencies({ trustVerified: false });
  const trustDir = path.join(tempRoot, 'trust-fail');
  const trustFail = makeService(trustDir, trustDeps, ['ubuntu-main'], 'tx-selftest-0003');
  await assert.rejects(() => trustFail.execute(aptPlan()), error => error?.code === 'REPOSITORY_TRUST_NOT_VERIFIED');
  assert.deepEqual(trustDeps.events.map(event => event[0]), ['trust']);
  assert.equal(fs.readdirSync(trustDir).length, 0);

  const noRollbackDeps = createDependencies({ healthy: false });
  const noRollbackDir = path.join(tempRoot, 'manual-recovery');
  const noRollback = makeService(noRollbackDir, noRollbackDeps, ['ubuntu-main'], 'tx-selftest-0004');
  await assert.rejects(() => noRollback.execute(aptPlan()), error => /manual recovery required/.test(error.message));
  assert.equal(noRollback.readJournal('tx-selftest-0004').state, 'failed-needs-recovery');
  assert.equal(noRollbackDeps.events.some(event => event[0] === 'execute' && event[1] === 'rollback'), false);

  const rollbackDeps = createDependencies({ healthy: false });
  const rollbackDir = path.join(tempRoot, 'rollback');
  const rollback = makeService(rollbackDir, rollbackDeps, ['fedora-base'], 'tx-selftest-0005');
  await assert.rejects(() => rollback.execute(rpmOstreePlan()), error => /rollback completed/.test(error.message));
  const rolledBack = rollback.readJournal('tx-selftest-0005');
  assert.equal(rolledBack.state, 'rolled-back');
  assert.deepEqual(rollbackDeps.events.find(event => event[0] === 'execute' && event[1] === 'rollback')?.[2], ['rpm-ostree', 'rollback']);

  const recoveryDeps = createDependencies();
  const recoveryDir = path.join(tempRoot, 'crash-recovery');
  const recovery = makeService(recoveryDir, recoveryDeps, ['fedora-base'], 'tx-selftest-0006');
  const crashPlan = rpmOstreePlan();
  const crashRecord = {
    schema: 'swir.system-package-transaction/0.1',
    id: 'tx-crash-000001',
    state: 'mutating',
    sequence: 2,
    createdAt: '2026-09-16T20:00:00.000Z',
    updatedAt: '2026-09-16T20:00:01.000Z',
    planDigest: digestPackagePlan(crashPlan),
    plan: crashPlan,
    trust: { verified: true, proofId: 'proof', repositoryId: 'fedora-base' },
    authorization: { grantId: 'old-grant', actorId: 'user:1000', scope: 'packages.mutate' },
    snapshot: { schema: 'swir.package-snapshot/0.1', installed: false, version: null },
    execution: null,
    health: null,
    recovery: { automaticRollbackAvailable: true, rollbackCommand: ['rpm-ostree', 'rollback'] },
    error: null,
    history: [
      { state: 'prepared', at: '2026-09-16T20:00:00.000Z', detail: 'prepared' },
      { state: 'mutating', at: '2026-09-16T20:00:01.000Z', detail: 'handoff' }
    ]
  };
  fs.writeFileSync(path.join(recoveryDir, 'tx-crash-000001.json'), `${JSON.stringify(crashRecord, null, 2)}\n`, { mode: 0o600 });
  const recovered = await recovery.recoverPending({ reason: 'startup recovery' });
  assert.deepEqual(recovered, [{ id: 'tx-crash-000001', status: 'rolled-back' }]);
  assert.equal(recovery.readJournal('tx-crash-000001').state, 'rolled-back');
  assert.equal(recoveryDeps.events.some(event => event[0] === 'authorize' && event[1] === 'packages.recover'), true);

  const corruptDir = path.join(tempRoot, 'corrupt');
  fs.mkdirSync(corruptDir, { recursive: true });
  const corruptPlan = rpmOstreePlan();
  const corrupt = { ...crashRecord, id: 'tx-corrupt-0001', plan: corruptPlan, planDigest: '0'.repeat(64) };
  fs.writeFileSync(path.join(corruptDir, 'tx-corrupt-0001.json'), JSON.stringify(corrupt), { mode: 0o600 });
  const corruptDeps = createDependencies();
  const corruptService = makeService(corruptDir, corruptDeps, ['fedora-base'], 'tx-selftest-0007');
  const corruptOutcome = await corruptService.recoverPending();
  assert.equal(corruptOutcome[0].status, 'corrupt');
  assert.equal(corruptDeps.events.some(event => event[0] === 'execute'), false);

  console.log('SWIR system package transaction service self-tests: OK');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
