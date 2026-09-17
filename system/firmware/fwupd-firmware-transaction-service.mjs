import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const fsp = fs.promises;
const BINARY = '/usr/bin/fwupdmgr';
const JOURNAL_ROOT = '/var/lib/swir/transactions/firmware';
const JOURNAL_SCHEMA = 'swir.firmware-transaction-journal/0.1';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TXID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9-]{20,64}$/i;
const VERSION = /^[^\u0000-\u001f\u007f]{1,128}$/;
const CHECKSUM = /^[A-Fa-f0-9]{32,128}$/;
const MAX_OUTPUT = 4 * 1024 * 1024;

function fail(code, message, cause) {
  const e = new Error(message, cause ? { cause } : undefined);
  e.name = 'FirmwareTransactionError'; e.code = code; throw e;
}
function assert(ok, code, message) { if (!ok) fail(code, message); }
function object(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function clean(v, max = 512) { return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
function token(v, code, label, pattern = ID) { const x = String(v ?? '').trim(); assert(pattern.test(x), code, `${label} is invalid`); return x; }
function maybeToken(v, code, label) { return v === null || v === undefined || v === '' ? null : token(v, code, label); }
function maybeVersion(v, field) { if (v === null || v === undefined || v === '') return null; return token(v, `INVALID_${field.toUpperCase()}`, field, VERSION); }
function checksums(v) {
  const out = [...new Set((Array.isArray(v) ? v : []).map(x => String(x ?? '').trim()).filter(Boolean))].sort();
  for (const x of out) assert(CHECKSUM.test(x), 'INVALID_FIRMWARE_CHECKSUM', 'firmware checksum is invalid');
  return out;
}
function canonical(plan) {
  return JSON.stringify({ schema: plan.schema, operation: plan.operation, provider: plan.provider, remoteId: plan.remoteId,
    source: plan.source, deviceId: plan.deviceId, releaseId: plan.releaseId, currentVersion: plan.currentVersion,
    targetVersion: plan.targetVersion, checksums: plan.checksums, requiresReboot: plan.requiresReboot, command: plan.command });
}
function digest(plan) { return crypto.createHash('sha256').update(canonical(plan)).digest('hex'); }
function findDevice(inv, id) { return (Array.isArray(inv?.devices) ? inv.devices : []).find(d => d?.deviceId === id) || null; }

export function buildFirmwareUpdatePlan(candidate) {
  assert(object(candidate), 'INVALID_FIRMWARE_CANDIDATE', 'firmware candidate must be an object');
  assert(candidate.remoteId === 'lvfs', 'UNTRUSTED_FIRMWARE_REMOTE', 'firmware update must come from LVFS');
  assert(candidate?.source?.class === 'fwupd-lvfs' && candidate?.source?.repositoryId === 'lvfs', 'UNTRUSTED_FIRMWARE_SOURCE', 'firmware source must be fwupd-lvfs');
  assert(candidate.trustedSource === true, 'UNTRUSTED_FIRMWARE_SOURCE', 'firmware candidate is not trusted');
  assert(candidate.directDownloadUrlExposed === false, 'FIRMWARE_DIRECT_URL_FORBIDDEN', 'direct firmware URLs are forbidden');
  assert(candidate.mutationAuthorized === false, 'FIRMWARE_PREAUTHORIZED_FORBIDDEN', 'discovery may not pre-authorize firmware mutation');
  const deviceId = token(candidate.deviceId, 'INVALID_DEVICE_ID', 'device id');
  const currentVersion = maybeVersion(candidate.currentVersion, 'current_version');
  const targetVersion = maybeVersion(candidate.version, 'target_version');
  assert(targetVersion && targetVersion !== currentVersion, 'FIRMWARE_ALREADY_CURRENT', 'target version must differ from current version');
  const plan = Object.freeze({
    schema: 'swir.firmware-update-plan/0.1', operation: 'update', provider: 'fwupd-lvfs', remoteId: 'lvfs',
    source: Object.freeze({ class: 'fwupd-lvfs', repositoryId: 'lvfs', ref: clean(candidate.source.ref, 256) || null }),
    deviceId, releaseId: maybeToken(candidate.releaseId, 'INVALID_RELEASE_ID', 'release id'), currentVersion, targetVersion,
    checksums: Object.freeze(checksums(candidate.checksums)), requiresReboot: candidate.requiresReboot === true,
    command: Object.freeze(['--assume-yes', '--no-reboot-check', 'update', deviceId])
  });
  return Object.freeze({ ...plan, digest: digest(plan) });
}

async function bootId() {
  const value = String(await fsp.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  assert(BOOT_ID.test(value), 'FIRMWARE_BOOT_ID_INVALID', 'boot identity is unavailable'); return value;
}
function runner(binary, args, options) {
  return new Promise((resolve, reject) => execFile(binary, args, options, (error, stdout, stderr) => {
    if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); } else resolve({ stdout, stderr, code: 0 });
  }));
}

export class GuardedFwupdFirmwareExecutor {
  #binary; #runner; #uid; #trust;
  constructor({ binary = BINARY, runner: run = runner, expectedOwnerUid = 0, enforceBinaryTrust = true } = {}) {
    assert(binary === BINARY || !enforceBinaryTrust, 'FWUPD_BINARY_NOT_ALLOWLISTED', 'production firmware mutation is pinned to /usr/bin/fwupdmgr');
    assert(typeof run === 'function', 'FWUPD_RUNNER_REQUIRED', 'runner is required');
    this.#binary = binary; this.#runner = run; this.#uid = expectedOwnerUid; this.#trust = enforceBinaryTrust;
  }
  async probe() {
    if (!this.#trust) return { available: true, binary: this.#binary, trustedBinary: true, testOverride: true };
    let st; try { st = await fsp.lstat(this.#binary); } catch (e) { if (e?.code === 'ENOENT') return { available: false, binary: this.#binary }; throw e; }
    assert(st.isFile() && !st.isSymbolicLink(), 'FWUPD_BINARY_INVALID', 'fwupdmgr must be a non-symlink regular file');
    assert(await fsp.realpath(this.#binary) === this.#binary, 'FWUPD_BINARY_SYMLINKED', 'fwupdmgr path is not trusted');
    assert((st.mode & 0o111) !== 0 && (st.mode & 0o022) === 0, 'FWUPD_BINARY_MODE_INVALID', 'fwupdmgr permissions are unsafe');
    if (this.#uid !== null && typeof st.uid === 'number') assert(st.uid === this.#uid, 'FWUPD_BINARY_OWNER_INVALID', 'fwupdmgr owner is not trusted');
    return { available: true, binary: this.#binary, trustedBinary: true };
  }
  async execute(plan) {
    assert(plan?.schema === 'swir.firmware-update-plan/0.1' && plan.provider === 'fwupd-lvfs' && plan.remoteId === 'lvfs', 'FIRMWARE_PLAN_PROVIDER_INVALID', 'invalid firmware provider');
    assert(plan?.source?.class === 'fwupd-lvfs' && plan?.source?.repositoryId === 'lvfs', 'FIRMWARE_PLAN_SOURCE_INVALID', 'invalid firmware source');
    assert(plan.digest === digest(plan), 'FIRMWARE_PLAN_DIGEST_INVALID', 'firmware plan digest mismatch');
    const expected = ['--assume-yes', '--no-reboot-check', 'update', token(plan.deviceId, 'INVALID_DEVICE_ID', 'device id')];
    assert(Array.isArray(plan.command) && plan.command.length === 4 && plan.command.every((v, i) => v === expected[i]), 'FWUPD_COMMAND_TAMPERED', 'fwupdmgr command template was changed');
    assert((await this.probe()).available, 'FWUPD_UNAVAILABLE', 'fwupdmgr is unavailable');
    const r = await this.#runner(this.#binary, expected, { shell: false, timeout: 1_200_000, maxBuffer: MAX_OUTPUT, windowsHide: true,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
    const stdout = String(r?.stdout ?? ''), stderr = String(r?.stderr ?? '');
    assert(Buffer.byteLength(stdout) <= MAX_OUTPUT && Buffer.byteLength(stderr) <= MAX_OUTPUT, 'FWUPD_OUTPUT_TOO_LARGE', 'fwupdmgr output too large');
    return Object.freeze({ exitCode: Number.isInteger(r?.code) ? r.code : 0, commandVerified: true, stdout, stderr, deviceId: plan.deviceId });
  }
}

export class FileFirmwareTransactionJournal {
  #root; #uid; #ownership;
  constructor({ root = JOURNAL_ROOT, expectedOwnerUid = 0, enforceOwnership = true } = {}) {
    assert(path.isAbsolute(root), 'JOURNAL_ROOT_INVALID', 'journal root must be absolute');
    this.#root = path.resolve(root); this.#uid = expectedOwnerUid; this.#ownership = enforceOwnership;
  }
  get root() { return this.#root; }
  async #ensure() {
    await fsp.mkdir(this.#root, { recursive: true, mode: 0o700 }); const st = await fsp.lstat(this.#root);
    assert(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0, 'JOURNAL_ROOT_UNTRUSTED', 'firmware journal root is unsafe');
    if (this.#ownership && this.#uid !== null && typeof st.uid === 'number') assert(st.uid === this.#uid, 'JOURNAL_ROOT_OWNER_INVALID', 'firmware journal owner is not trusted');
  }
  #path(id) { assert(TXID.test(id), 'TRANSACTION_ID_INVALID', 'invalid transaction id'); const p = path.resolve(this.#root, `${id}.json`); assert(path.dirname(p) === this.#root, 'JOURNAL_PATH_ESCAPE', 'journal path escaped root'); return p; }
  async write(entry) {
    assert(object(entry), 'JOURNAL_ENTRY_INVALID', 'journal entry must be an object'); await this.#ensure();
    const file = this.#path(entry.transactionId), tmp = `${file}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await fsp.chmod(tmp, 0o600); await fsp.rename(tmp, file);
    const st = await fsp.lstat(file); assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o077) === 0, 'JOURNAL_ENTRY_UNTRUSTED', 'journal entry is unsafe'); return file;
  }
  async read(id) {
    await this.#ensure(); const file = this.#path(id), st = await fsp.lstat(file);
    assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o077) === 0, 'JOURNAL_ENTRY_UNTRUSTED', 'journal entry is unsafe');
    let entry; try { entry = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { fail('JOURNAL_ENTRY_INVALID', 'journal JSON is invalid', e); }
    assert(entry?.transactionId === id, 'JOURNAL_TRANSACTION_MISMATCH', 'journal id does not match filename'); return entry;
  }
}

export class FirmwareUpdateTransactionService {
  #discovery; #authorizer; #executor; #journal; #clock; #id; #boot;
  constructor({ discovery, authorizer, executor = new GuardedFwupdFirmwareExecutor(), journal = new FileFirmwareTransactionJournal(),
    clock = () => new Date().toISOString(), transactionIdFactory = () => crypto.randomUUID(), bootIdProvider = bootId } = {}) {
    assert(typeof discovery?.inventory === 'function', 'FIRMWARE_DISCOVERY_REQUIRED', 'discovery.inventory is required');
    assert(typeof authorizer?.authorize === 'function', 'FIRMWARE_AUTHORIZER_REQUIRED', 'authorizer.authorize is required');
    this.#discovery = discovery; this.#authorizer = authorizer; this.#executor = executor; this.#journal = journal; this.#clock = clock; this.#id = transactionIdFactory; this.#boot = bootIdProvider;
  }
  async update(candidate, context = {}) {
    const plan = buildFirmwareUpdatePlan(candidate), transactionId = this.#id(); assert(TXID.test(transactionId), 'TRANSACTION_ID_INVALID', 'invalid transaction id');
    const bootIdBefore = await this.#boot(); assert(BOOT_ID.test(bootIdBefore), 'FIRMWARE_BOOT_ID_INVALID', 'invalid boot identity');
    const beforeInv = await this.#discovery.inventory(), before = findDevice(beforeInv, plan.deviceId);
    assert(beforeInv?.schema === 'swir.fwupd-lvfs-inventory/0.1' && beforeInv.available === true && before, 'FIRMWARE_DEVICE_NOT_FOUND', 'firmware device is unavailable before update');
    if (plan.currentVersion) assert(before.version === plan.currentVersion, 'FIRMWARE_CURRENT_VERSION_CHANGED', 'firmware version changed before update');
    let entry = { schema: JOURNAL_SCHEMA, transactionId, status: 'planned', createdAt: this.#clock(), updatedAt: this.#clock(), plan, planDigest: plan.digest,
      actorId: context.actorId ?? null, before: { deviceId: before.deviceId, version: before.version ?? null }, result: null,
      recovery: { automaticRollback: false, safeToAutoRetry: false, rebootRequired: plan.requiresReboot, operatorReviewRequired: false, bootIdBefore } };
    await this.#journal.write(entry);
    const grant = await this.#authorizer.authorize({ schema: 'swir.firmware-authorization-request/0.1', operation: 'update', planDigest: plan.digest,
      deviceId: plan.deviceId, releaseId: plan.releaseId, context: { ...(context.actorId ? { actorId: context.actorId } : {}), allowUserInteraction: context.allowUserInteraction === true } });
    assert(grant?.schema === 'swir.firmware-authorization-grant/0.1' && grant.authorized === true, 'FIRMWARE_AUTHORIZATION_DENIED', 'firmware authorization denied');
    assert(grant.planDigest === plan.digest && grant.deviceId === plan.deviceId && grant.operation === 'update' && (!plan.releaseId || grant.releaseId === plan.releaseId), 'FIRMWARE_AUTHORIZATION_BINDING_MISMATCH', 'firmware grant binding mismatch');
    entry = { ...entry, status: 'authorized', updatedAt: this.#clock(), authorization: { grantId: grant.grantId ?? null, actorId: grant.actorId, actionId: grant.actionId } }; await this.#journal.write(entry);
    entry = { ...entry, status: 'executing', updatedAt: this.#clock() }; await this.#journal.write(entry);
    try {
      const execution = await this.#executor.execute(plan); assert(execution?.exitCode === 0 && execution?.commandVerified === true, 'FIRMWARE_EXECUTION_UNVERIFIED', 'firmware executor did not verify success');
      const afterInv = await this.#discovery.inventory(), after = findDevice(afterInv, plan.deviceId); assert(afterInv?.available === true && after, 'FIRMWARE_DEVICE_MISSING_AFTER_UPDATE', 'firmware device missing after update');
      const applied = after.version === plan.targetVersion, status = applied ? 'committed' : (plan.requiresReboot ? 'staged-reboot-required' : 'verification-failed');
      entry = { ...entry, status, updatedAt: this.#clock(), result: { exitCode: execution.exitCode, commandVerified: true, afterVersion: after.version ?? null,
        targetVersion: plan.targetVersion, versionApplied: applied, postconditionVerified: applied || status === 'staged-reboot-required' },
        recovery: { automaticRollback: false, safeToAutoRetry: false, rebootRequired: status === 'staged-reboot-required', operatorReviewRequired: status === 'verification-failed', bootIdBefore } };
      await this.#journal.write(entry); assert(status !== 'verification-failed', 'FIRMWARE_POSTCONDITION_FAILED', 'target firmware version was not observed');
      return Object.freeze({ schema: 'swir.firmware-transaction-result/0.1', transactionId, status, planDigest: plan.digest, deviceId: plan.deviceId,
        currentVersion: plan.currentVersion, targetVersion: plan.targetVersion, rebootRequired: entry.recovery.rebootRequired, automaticRollback: false, postconditionVerified: entry.result.postconditionVerified });
    } catch (e) {
      const cur = await this.#journal.read(transactionId).catch(() => entry); await this.#journal.write({ ...cur, status: 'failed-needs-recovery', updatedAt: this.#clock(),
        error: { code: clean(e?.code || 'FIRMWARE_UPDATE_FAILED', 128), message: clean(e?.message || 'firmware update failed', 1024) },
        recovery: { automaticRollback: false, safeToAutoRetry: false, rebootRequired: plan.requiresReboot, operatorReviewRequired: true, bootIdBefore } }).catch(() => {}); throw e;
    }
  }
  async reconcileAfterBoot(transactionId) {
    const entry = await this.#journal.read(transactionId); assert(entry?.schema === JOURNAL_SCHEMA && entry.status === 'staged-reboot-required', 'FIRMWARE_RECONCILE_NOT_STAGED', 'transaction is not reboot-staged');
    const d = digest(entry.plan); assert(d === entry.plan?.digest && d === entry.planDigest, 'FIRMWARE_JOURNAL_PLAN_TAMPERED', 'firmware journal plan was modified');
    assert(entry.plan?.source?.class === 'fwupd-lvfs' && entry.plan?.source?.repositoryId === 'lvfs', 'FIRMWARE_JOURNAL_SOURCE_TAMPERED', 'firmware source is not LVFS');
    const before = entry.recovery?.bootIdBefore, afterBoot = await this.#boot(); assert(BOOT_ID.test(before) && BOOT_ID.test(afterBoot), 'FIRMWARE_JOURNAL_BOOT_ID_INVALID', 'boot identity is invalid');
    assert(afterBoot !== before, 'FIRMWARE_REBOOT_NOT_OBSERVED', 'a real reboot has not been observed');
    const device = findDevice(await this.#discovery.inventory(), entry.plan.deviceId); assert(device, 'FIRMWARE_DEVICE_MISSING_AFTER_REBOOT', 'firmware device missing after reboot');
    const applied = device.version === entry.plan.targetVersion, now = this.#clock();
    const next = { ...entry, status: applied ? 'committed-after-reboot' : 'failed-needs-recovery', updatedAt: now, ...(applied ? { completedAt: now } : {}),
      recovery: { ...entry.recovery, bootIdAfter: afterBoot, rebootRequired: false, operatorReviewRequired: !applied, automaticRollback: false, safeToAutoRetry: false },
      result: { ...(entry.result || {}), versionApplied: applied, postconditionVerified: applied, observedVersion: device.version ?? null, reconciledAfterBoot: true } };
    await this.#journal.write(next); return next;
  }
  async inspectRecovery(transactionId) {
    const entry = await this.#journal.read(transactionId), d = digest(entry.plan); assert(d === entry.planDigest && d === entry.plan?.digest, 'JOURNAL_PLAN_TAMPERED', 'firmware journal plan was modified');
    assert(entry.plan?.provider === 'fwupd-lvfs' && entry.plan?.remoteId === 'lvfs', 'JOURNAL_SOURCE_TAMPERED', 'firmware source is not LVFS');
    return Object.freeze({ schema: 'swir.firmware-recovery-assessment/0.1', transactionId, status: entry.status, deviceId: entry.plan.deviceId,
      targetVersion: entry.plan.targetVersion, rebootRequired: entry.recovery?.rebootRequired === true, automaticRollback: false,
      operatorReviewRequired: entry.recovery?.operatorReviewRequired === true, safeToAutoRetry: false });
  }
}

export const FirmwareTransactionPolicy = Object.freeze({ schema: 'swir.firmware-transaction-policy/0.1', provider: 'fwupd-lvfs', remoteId: 'lvfs', binary: BINARY,
  commandTemplate: Object.freeze(['--assume-yes', '--no-reboot-check', 'update', '<device-id>']), arbitraryFirmwareUrl: false, localFirmwareInstall: false,
  arbitraryFwupdArguments: false, shell: false, authorizationRequired: true, journalBeforeMutation: true, postUpdateInventoryRequired: true,
  automaticRollbackClaimed: false, rebootAware: true, failClosedOnUnexpectedVersion: true });
