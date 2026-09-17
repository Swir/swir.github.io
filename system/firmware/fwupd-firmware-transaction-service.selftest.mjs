import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FileFirmwareTransactionJournal,
  FirmwareTransactionPolicy,
  FirmwareUpdateTransactionService,
  GuardedFwupdFirmwareExecutor,
  buildFirmwareUpdatePlan
} from './fwupd-firmware-transaction-service.mjs';
import { PolkitFirmwareAuthorizationBroker } from '../security/polkit-firmware-authorization-broker.mjs';

const BOOT_A = '11111111-1111-4111-8111-111111111111';
const BOOT_B = '22222222-2222-4222-8222-222222222222';

const candidate = Object.freeze({
  deviceId: '0123456789abcdef0123456789abcdef01234567',
  deviceName: 'Test Firmware Device',
  currentVersion: '1.0.0',
  version: '2.0.0',
  releaseId: 'lvfs-release-42',
  remoteId: 'lvfs',
  checksums: ['a'.repeat(64)],
  requiresReboot: false,
  source: { class: 'fwupd-lvfs', repositoryId: 'lvfs', ref: 'fwupd:test:42' },
  trustedSource: true,
  directDownloadUrlExposed: false,
  mutationAuthorized: false
});

const plan = buildFirmwareUpdatePlan(candidate);
assert.equal(plan.provider, 'fwupd-lvfs');
assert.equal(plan.remoteId, 'lvfs');
assert.equal(plan.command.join(' '), `--assume-yes --no-reboot-check update ${candidate.deviceId}`);
assert.match(plan.digest, /^[a-f0-9]{64}$/);
assert.equal(plan.requiresReboot, false);

assert.throws(() => buildFirmwareUpdatePlan({ ...candidate, remoteId: 'vendor-test' }), error => error.code === 'UNTRUSTED_FIRMWARE_REMOTE');
assert.throws(() => buildFirmwareUpdatePlan({ ...candidate, mutationAuthorized: true }), error => error.code === 'FIRMWARE_PREAUTHORIZED_FORBIDDEN');
assert.throws(() => buildFirmwareUpdatePlan({ ...candidate, directDownloadUrlExposed: true }), error => error.code === 'FIRMWARE_DIRECT_URL_FORBIDDEN');

let version = '1.0.0';
const discovery = {
  async inventory() {
    return {
      schema: 'swir.fwupd-lvfs-inventory/0.1', available: true, devices: [{ deviceId: candidate.deviceId, version }], candidates: []
    };
  }
};
const authorizationRequests = [];
const authorizer = {
  async authorize(request) {
    authorizationRequests.push(request);
    return {
      schema: 'swir.firmware-authorization-grant/0.1', authorized: true,
      grantId: 'firmware-grant-0001', actionId: 'org.swir.system.firmware.update', actorId: 'uid:1000',
      operation: request.operation, deviceId: request.deviceId, releaseId: request.releaseId, planDigest: request.planDigest
    };
  }
};
const executorCalls = [];
const executor = {
  async execute(receivedPlan) {
    executorCalls.push(receivedPlan);
    assert.equal(receivedPlan.digest, plan.digest);
    version = '2.0.0';
    return { exitCode: 0, commandVerified: true, stdout: '', stderr: '' };
  }
};

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'swir-firmware-journal-'));
const journalRoot = path.join(temp, 'journal');
const journal = new FileFirmwareTransactionJournal({ root: journalRoot, expectedOwnerUid: null, enforceOwnership: false });
const service = new FirmwareUpdateTransactionService({
  discovery, authorizer, executor, journal,
  transactionIdFactory: () => 'tx-firmware-0001',
  clock: (() => { let n = 0; return () => `2026-09-17T01:00:0${n++}.000Z`; })(),
  bootIdProvider: async () => BOOT_A
});
const result = await service.update(candidate, { actorId: 'uid:1000' });
assert.equal(result.status, 'committed');
assert.equal(result.postconditionVerified, true);
assert.equal(result.automaticRollback, false);
assert.equal(executorCalls.length, 1);
assert.equal(authorizationRequests[0].planDigest, plan.digest);
const committedEntry = await journal.read('tx-firmware-0001');
assert.equal(committedEntry.status, 'committed');
assert.equal(committedEntry.result.afterVersion, '2.0.0');
const entryStat = await fs.stat(path.join(journalRoot, 'tx-firmware-0001.json'));
assert.equal(entryStat.mode & 0o077, 0);
const recovery = await service.inspectRecovery('tx-firmware-0001');
assert.equal(recovery.automaticRollback, false);
assert.equal(recovery.safeToAutoRetry, false);

version = '1.0.0';
const rebootJournal = new FileFirmwareTransactionJournal({ root: path.join(temp, 'reboot-journal'), expectedOwnerUid: null, enforceOwnership: false });
let rebootBootId = BOOT_A;
const rebootService = new FirmwareUpdateTransactionService({
  discovery,
  authorizer,
  executor: { async execute() { return { exitCode: 0, commandVerified: true, stdout: '', stderr: '' }; } },
  journal: rebootJournal,
  transactionIdFactory: () => 'tx-firmware-reboot',
  clock: () => '2026-09-17T01:10:00.000Z',
  bootIdProvider: async () => rebootBootId
});
const staged = await rebootService.update({ ...candidate, requiresReboot: true }, { actorId: 'uid:1000' });
assert.equal(staged.status, 'staged-reboot-required');
assert.equal(staged.rebootRequired, true);
await assert.rejects(() => rebootService.reconcileAfterBoot('tx-firmware-reboot'), error => error.code === 'FIRMWARE_REBOOT_NOT_OBSERVED');
version = '2.0.0';
rebootBootId = BOOT_B;
const reconciled = await rebootService.reconcileAfterBoot('tx-firmware-reboot');
assert.equal(reconciled.status, 'committed-after-reboot');
assert.equal(reconciled.result.reconciledAfterBoot, true);
assert.equal(reconciled.recovery.bootIdBefore, BOOT_A);
assert.equal(reconciled.recovery.bootIdAfter, BOOT_B);
assert.equal(reconciled.recovery.operatorReviewRequired, false);

version = '1.0.0';
const failedJournal = new FileFirmwareTransactionJournal({ root: path.join(temp, 'failed-journal'), expectedOwnerUid: null, enforceOwnership: false });
const failedService = new FirmwareUpdateTransactionService({
  discovery,
  authorizer,
  executor: { async execute() { return { exitCode: 0, commandVerified: true, stdout: '', stderr: '' }; } },
  journal: failedJournal,
  transactionIdFactory: () => 'tx-firmware-failed',
  clock: () => '2026-09-17T01:20:00.000Z',
  bootIdProvider: async () => BOOT_A
});
await assert.rejects(() => failedService.update(candidate, { actorId: 'uid:1000' }), error => error.code === 'FIRMWARE_POSTCONDITION_FAILED');
const failedEntry = await failedJournal.read('tx-firmware-failed');
assert.equal(failedEntry.status, 'failed-needs-recovery');
assert.equal(failedEntry.recovery.operatorReviewRequired, true);

const guardedCalls = [];
const guarded = new GuardedFwupdFirmwareExecutor({
  binary: '/test/fwupdmgr', enforceBinaryTrust: false,
  runner: async (binary, args, options) => { guardedCalls.push({ binary, args, options }); return { stdout: 'ok', stderr: '', code: 0 }; }
});
await guarded.execute(plan);
assert.equal(guardedCalls[0].options.shell, false);
assert.deepEqual(guardedCalls[0].args, ['--assume-yes', '--no-reboot-check', 'update', candidate.deviceId]);
await assert.rejects(() => guarded.execute({ ...plan, command: ['update', candidate.deviceId, '--force'] }), error => error.code === 'FIRMWARE_PLAN_DIGEST_INVALID');

const polkitCalls = [];
assert.throws(() => new PolkitFirmwareAuthorizationBroker({ pkcheckPath: '/tmp/pkcheck' }), error => error.code === 'INVALID_POLKIT_PATH');

const broker = new PolkitFirmwareAuthorizationBroker({
  pkcheckPath: '/usr/bin/pkcheck',
  fileProbe: () => ({ isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100755 }),
  processProbe: async () => ({ pid: 4242, uid: 1000, startTime: '987654' }),
  runner: async (command, args) => { polkitCalls.push({ command, args }); return { exitCode: 0, stdout: '', stderr: '' }; },
  grantIdFactory: () => 'firmware-grant-0002',
  clock: () => '2026-09-17T01:30:00.000Z'
});
const grant = await broker.authorize({
  schema: 'swir.firmware-authorization-request/0.1', operation: 'update', deviceId: candidate.deviceId,
  releaseId: candidate.releaseId, planDigest: plan.digest, context: { actorId: 'uid:1000' }
});
assert.equal(grant.authorized, true);
assert.equal(grant.deviceId, candidate.deviceId);
assert.equal(polkitCalls[0].args.includes('org.swir.system.firmware.update'), true);
assert.equal(polkitCalls[0].args.includes('--allow-user-interaction'), false);

assert.equal(FirmwareTransactionPolicy.arbitraryFirmwareUrl, false);
assert.equal(FirmwareTransactionPolicy.automaticRollbackClaimed, false);
assert.equal(FirmwareTransactionPolicy.journalBeforeMutation, true);

await fs.rm(temp, { recursive: true, force: true });
console.log('fwupd firmware transaction service self-test: OK');
