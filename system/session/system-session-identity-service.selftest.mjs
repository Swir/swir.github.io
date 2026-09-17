import assert from 'node:assert/strict';
import { SystemSessionIdentityService, SystemSessionIdentityPolicy } from './system-session-identity-service.mjs';

const calls = [];
const properties = new Map([
  ['2', `Id=2\nUser=1000\nName=swir\nSeat=seat0\nRemote=no\nActive=yes\nState=active\nType=wayland\nClass=user\nLeader=4242\nDisplay=\nTTY=tty2\n`],
  ['5', `Id=5\nUser=1001\nName=remote\nSeat=\nRemote=yes\nActive=yes\nState=active\nType=tty\nClass=user\nLeader=5252\nDisplay=\nTTY=pts/0\n`]
]);

function runner(binary, args, options) {
  calls.push({ binary, args: [...args], options });
  if (args[0] === 'list-sessions') return Promise.resolve({ code: 0, stdout: '2 1000 swir seat0 tty2\n5 1001 remote - pts/0\n', stderr: '' });
  if (args[0] === 'show-session') return Promise.resolve({ code: 0, stdout: properties.get(args[1]) || '', stderr: '' });
  throw new Error(`unexpected loginctl call: ${args.join(' ')}`);
}

const service = new SystemSessionIdentityService({
  binary: '/test/loginctl',
  enforceBinaryTrust: false,
  runner,
  processProbe: () => ({ pid: 777, uid: 1000, startTime: '123456' }),
  clock: () => '2026-09-17T02:00:00.000Z'
});

const inventory = await service.inventory();
assert.equal(inventory.schema, 'swir.system-session-inventory/0.1');
assert.equal(inventory.readOnly, true);
assert.equal(inventory.sessions.length, 2);
assert.equal(inventory.sessions[0].type, 'wayland');
assert.equal(inventory.sessions[1].remote, true);

const active = await service.resolveActiveLocalDesktopSession({ uid: 1000 });
assert.equal(active.sessionId, '2');
assert.equal(active.username, 'swir');

const attestation = await service.attestCurrentProcess({ actorId: 'uid:1000' });
assert.equal(attestation.schema, 'swir.system-session-attestation/0.1');
assert.equal(attestation.actorId, 'uid:1000');
assert.equal(attestation.sessionActorId, 'session:2:uid:1000');
assert.equal(attestation.remote, false);
assert.equal(attestation.active, true);
assert.equal(attestation.authorizationAuthority, 'polkit-separate');
assert.match(attestation.sessionDigest, /^[a-f0-9]{64}$/);
assert.deepEqual(attestation.processSubject, { pid: 777, uid: 1000, startTime: '123456' });

await assert.rejects(() => service.attestCurrentProcess({ actorId: 'uid:0' }), error => error?.code === 'ACTOR_BINDING_MISMATCH');

const noDesktop = new SystemSessionIdentityService({
  binary: '/test/loginctl',
  enforceBinaryTrust: false,
  runner: async (_binary, args) => args[0] === 'list-sessions'
    ? { code: 0, stdout: '5 1001 remote - pts/0\n', stderr: '' }
    : { code: 0, stdout: properties.get('5'), stderr: '' },
  processProbe: () => ({ pid: 888, uid: 1001, startTime: '999' })
});
await assert.rejects(() => noDesktop.attestCurrentProcess(), error => error?.code === 'ACTIVE_DESKTOP_SESSION_NOT_FOUND');

const ambiguous = new SystemSessionIdentityService({
  binary: '/test/loginctl',
  enforceBinaryTrust: false,
  runner: async (_binary, args) => {
    if (args[0] === 'list-sessions') return { code: 0, stdout: '2 1000 swir seat0 tty2\n3 1000 swir seat0 tty3\n', stderr: '' };
    const id = args[1];
    return { code: 0, stdout: id === '2' ? properties.get('2') : properties.get('2').replace('Id=2', 'Id=3').replace('Leader=4242', 'Leader=4343'), stderr: '' };
  },
  processProbe: () => ({ pid: 999, uid: 1000, startTime: '111' })
});
await assert.rejects(() => ambiguous.attestCurrentProcess(), error => error?.code === 'AMBIGUOUS_ACTIVE_DESKTOP_SESSION');

for (const call of calls) {
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.env, { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
  assert(!call.args.includes('--show-secrets'));
}
assert.equal(SystemSessionIdentityPolicy.readOnly, true);
assert.equal(SystemSessionIdentityPolicy.arbitraryUidOverride, false);
assert.equal(SystemSessionIdentityPolicy.arbitrarySessionOverride, false);
assert.equal(SystemSessionIdentityPolicy.authorizationAuthority, 'polkit-separate');

console.log('System session identity self-test: OK');