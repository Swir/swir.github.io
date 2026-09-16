import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SystemPackageTransactionService,
  digestPackagePlan,
  validatePackageHealth,
  validatePackageSnapshot
} from './package-transaction-service.mjs';

const plan = {
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

const snapshot = {
  schema: 'swir.package-snapshot/0.1',
  capturedAt: '2026-09-16T20:40:00.000Z',
  packageId: 'org.example.editor',
  manager: 'apt',
  packageName: 'example-editor',
  installed: false,
  version: null,
  query: { source: 'dpkg-query', exitCode: 1, signal: null }
};

const health = {
  schema: 'swir.package-health/0.1',
  packageId: 'org.example.editor',
  packageName: 'example-editor',
  healthy: true,
  checks: [{ id: 'native-entry-point', ok: true, resolved: '/usr/bin/example-editor' }]
};

assert.equal(validatePackageSnapshot(snapshot, {
  manager: 'apt',
  packageName: 'example-editor',
  packageId: 'org.example.editor'
}), snapshot);
assert.throws(() => validatePackageSnapshot({ ...snapshot, packageId: 'org.attacker.app' }, {
  manager: 'apt', packageName: 'example-editor', packageId: 'org.example.editor'
}), error => error?.code === 'SNAPSHOT_PACKAGE_MISMATCH');
assert.throws(() => validatePackageSnapshot({ ...snapshot, manager: 'dnf' }, {
  manager: 'apt', packageName: 'example-editor', packageId: 'org.example.editor'
}), error => error?.code === 'SNAPSHOT_MANAGER_MISMATCH');
assert.throws(() => validatePackageSnapshot({ ...snapshot, query: { ...snapshot.query, source: 'rpm' } }, {
  manager: 'apt', packageName: 'example-editor', packageId: 'org.example.editor'
}), error => error?.code === 'SNAPSHOT_SOURCE_MISMATCH');
assert.throws(() => validatePackageSnapshot({ ...snapshot, installed: true, version: null }, {
  manager: 'apt', packageName: 'example-editor', packageId: 'org.example.editor'
}), error => error?.code === 'INVALID_SNAPSHOT_VERSION');

assert.equal(validatePackageHealth(health, {
  packageName: 'example-editor',
  packageId: 'org.example.editor'
}), health);
assert.throws(() => validatePackageHealth({ ...health, packageName: 'other-package' }, {
  packageName: 'example-editor', packageId: 'org.example.editor'
}), error => error?.code === 'HEALTH_PACKAGE_MISMATCH');
assert.throws(() => validatePackageHealth({ ...health, checks: [] }, {
  packageName: 'example-editor', packageId: 'org.example.editor'
}), error => error?.code === 'INVALID_HEALTH_RESULT');

function dependencies({ healthResult = health } = {}) {
  return {
    executor: { async execute() { return { schema: 'swir.package-executor-result/0.1', ok: true, exitCode: 0 }; } },
    authorizationBroker: { async authorize() { return { authorized: true, grantId: 'grant-test', actorId: 'user:1000' }; } },
    trustVerifier: { async verifyRepository() { return { verified: true, proofId: 'repo-proof' }; } },
    snapshotProvider: { async capture() { return structuredClone(snapshot); } },
    healthVerifier: { async verify() { return structuredClone(healthResult); } }
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-pkg-security-'));
try {
  const serviceDir = path.join(root, 'journal');
  const service = new SystemPackageTransactionService({
    journalDirectory: serviceDir,
    ...dependencies(),
    allowlistedRepositories: ['ubuntu-main'],
    idFactory: () => 'tx-secure-000001',
    clock: () => '2026-09-16T20:40:00.000Z'
  });
  const result = await service.execute(plan);
  assert.equal(result.state, 'committed');

  const originalPath = path.join(serviceDir, 'tx-secure-000001.json');
  const record = JSON.parse(fs.readFileSync(originalPath, 'utf8'));
  assert.equal(record.planDigest, digestPackagePlan(record.plan));

  const mismatchedPath = path.join(serviceDir, 'tx-secure-000002.json');
  fs.writeFileSync(mismatchedPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  assert.throws(() => service.readJournal('tx-secure-000002'), error => error?.code === 'JOURNAL_ID_PATH_MISMATCH');
  fs.rmSync(mismatchedPath);

  fs.chmodSync(originalPath, 0o666);
  assert.throws(() => service.readJournal('tx-secure-000001'), error => error?.code === 'UNSAFE_JOURNAL_FILE_MODE');
  fs.chmodSync(originalPath, 0o600);

  const badHealthDir = path.join(root, 'bad-health');
  const badHealth = new SystemPackageTransactionService({
    journalDirectory: badHealthDir,
    ...dependencies({ healthResult: { ...health, packageId: 'org.attacker.app' } }),
    allowlistedRepositories: ['ubuntu-main'],
    idFactory: () => 'tx-secure-000003',
    clock: () => '2026-09-16T20:40:01.000Z'
  });
  await assert.rejects(
    () => badHealth.execute(plan),
    error => error?.code === 'HEALTH_PACKAGE_MISMATCH' && /manual recovery required/.test(error.message)
  );
  assert.equal(badHealth.readJournal('tx-secure-000003').state, 'failed-needs-recovery');

  const unsafeDir = path.join(root, 'unsafe-dir');
  fs.mkdirSync(unsafeDir, { mode: 0o700 });
  fs.chmodSync(unsafeDir, 0o777);
  assert.throws(() => new SystemPackageTransactionService({
    journalDirectory: unsafeDir,
    ...dependencies(),
    allowlistedRepositories: ['ubuntu-main']
  }), error => error?.code === 'UNSAFE_JOURNAL_DIRECTORY_MODE');

  console.log('SWIR package transaction tamper-resistance self-tests: OK');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
