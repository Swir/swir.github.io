import assert from 'node:assert/strict';
import { FwupdLvfsPolicy, FwupdLvfsService, assertSafeFwupdLvfsInventory } from './fwupd-lvfs-service.mjs';

const calls = [];
const runner = async (binary, args, options) => {
  calls.push({ binary, args: [...args], options: { ...options, env: { ...options.env } } });
  if (args[0] === 'get-devices') {
    return { stdout: JSON.stringify({ Devices: [
      { DeviceId: 'dev-1', Name: 'System Firmware', Vendor: 'Example', Version: '1.0', VersionFormat: 'plain', Plugin: 'uefi_capsule', Guid: ['11111111-1111-1111-1111-111111111111'], Flags: ['updatable'] },
      { DeviceId: 'dev-2', Name: 'Dock', Version: '3.0', Plugin: 'thunderbolt' }
    ] }) };
  }
  if (args[0] === 'get-updates') {
    return { stdout: JSON.stringify({ Devices: [
      { DeviceId: 'dev-1', Name: 'System Firmware', Version: '1.0', Releases: [
        { Version: '1.1', ReleaseId: 'lvfs-100', RemoteId: 'lvfs', Summary: 'Security update', Flags: ['needs-reboot'], Checksums: ['SHA256:abcd'] },
        { Version: '1.2-beta', ReleaseId: 'vendor-1', RemoteId: 'vendor-testing', Summary: 'Untrusted for SWIR automatic presentation' }
      ] }
    ] }) };
  }
  throw new Error(`Unexpected command ${args[0]}`);
};

const service = new FwupdLvfsService({ binary: '/test/fwupdmgr', runner, expectedOwnerUid: null, enforceBinaryTrust: false });
const inventory = await service.inventory();
assertSafeFwupdLvfsInventory(inventory);
assert.equal(inventory.available, true);
assert.equal(inventory.devices.length, 2);
assert.equal(inventory.candidates.length, 1);
assert.equal(inventory.ignoredNonLvfsCandidates, 1);
assert.equal(inventory.candidates[0].source.class, 'fwupd-lvfs');
assert.equal(inventory.candidates[0].source.repositoryId, 'lvfs');
assert.equal(inventory.candidates[0].mutationAuthorized, false);
assert.equal(inventory.candidates[0].requiresReboot, true);
assert.equal(calls.length, 2);
for (const call of calls) {
  assert.equal(call.options.shell, false);
  assert.equal(call.options.env.PATH, '/usr/sbin:/usr/bin:/sbin:/bin');
  assert.deepEqual(call.args.slice(1), ['--json']);
  assert.ok(['get-devices', 'get-updates'].includes(call.args[0]));
}
assert.equal(FwupdLvfsPolicy.refreshCommandExposed, false);
assert.equal(FwupdLvfsPolicy.updateCommandExposed, false);
assert.equal(FwupdLvfsPolicy.mutationRequiresSeparatePrivilegedTransaction, true);

assert.throws(() => new FwupdLvfsService({ binary: '/tmp/fwupdmgr' }), error => error?.code === 'FWUPD_BINARY_NOT_ALLOWLISTED');
assert.throws(() => assertSafeFwupdLvfsInventory({ ...inventory, mutationCapable: true }), error => error?.code === 'FWUPD_MUTATION_BOUNDARY_INVALID');
assert.throws(() => assertSafeFwupdLvfsInventory({ ...inventory, candidates: [{ ...inventory.candidates[0], remoteId: 'vendor' }] }), error => error?.code === 'FWUPD_REMOTE_INVALID');

console.log('fwupd/LVFS read-only service self-test: OK');
