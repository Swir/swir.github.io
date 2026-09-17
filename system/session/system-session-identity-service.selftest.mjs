import assert from 'node:assert/strict';
import { SystemSessionIdentityService, SystemSessionIdentityPolicy, createSessionBoundAuthorizationContext, selectActiveLocalSession } from './system-session-identity-service.mjs';

const calls = [];
const sessionData = new Map([
  ['1', `Id=1\nUser=2000\nName=remote\nRemote=yes\nActive=yes\nState=active\nType=x11\nClass=user\nSeat=seat0\nLeader=201\nDisplay=:9\nTTY=\nService=sshd\n`],
  ['2', `Id=2\nUser=1001\nName=inactive\nRemote=no\nActive=no\nState=closing\nType=wayland\nClass=user\nSeat=seat0\nLeader=202\nDisplay=\nTTY=tty2\nService=gdm-password\n`],
  ['3', `Id=3\nUser=1002\nName=seat1user\nRemote=no\nActive=yes\nState=active\nType=x11\nClass=user\nSeat=seat1\nLeader=203\nDisplay=:1\nTTY=tty3\nService=gdm-password\n`],
  ['4', `Id=4\nUser=1000\nName=alice\nRemote=no\nActive=yes\nState=active\nType=wayland\nClass=user\nSeat=seat0\nLeader=204\nDisplay=wayland-0\nTTY=tty1\nService=gdm-password\n`],
  ['5', `Id=5\nUser=0\nName=root\nRemote=no\nActive=yes\nState=active\nType=wayland\nClass=user\nSeat=seat0\nLeader=205\nDisplay=wayland-1\nTTY=tty4\nService=test\n`]
]);

const runner = async (binary, args, options) => {
  calls.push({ binary, args: [...args], options });
  assert.equal(binary, '/test/loginctl');
  assert.equal(options.shell, false);
  assert.deepEqual(options.env, { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
  if (args[0] === 'list-sessions') {
    return { code: 0, stdout: '1 2000 remote seat0 pts/1\n2 1001 inactive seat0 tty2\n3 1002 seat1user seat1 tty3\n4 1000 alice seat0 tty1\n5 0 root seat0 tty4\n../../evil 999 bad seat0 x\n', stderr: '' };
  }
  if (args[0] === 'show-session') {
    assert.match(args[1], /^[A-Za-z0-9_.:-]+$/);
    assert.notEqual(args[1], '../../evil');
    const stdout = sessionData.get(args[1]);
    if (!stdout) throw Object.assign(new Error('unknown fixture session'), { code: 'ENOENT' });
    return { code: 0, stdout, stderr: '' };
  }
  throw new Error(`unexpected command: ${args.join(' ')}`);
};

const service = new SystemSessionIdentityService({
  binary: '/test/loginctl',
  runner,
  enforceBinaryTrust: false,
  expectedOwnerUid: null
});

const inventory = await service.inventory();
assert.equal(inventory.schema, 'swir.system-session-inventory/0.1');
assert.equal(inventory.readOnly, true);
assert.equal(inventory.mutationCapable, false);
assert.equal(inventory.arbitrarySessionOverride, false);
assert.equal(inventory.secretsExposed, false);
assert.equal(inventory.sessions.length, 5);
assert.equal(inventory.activeActor.actorId, 'uid:1000');
assert.equal(inventory.activeActor.sessionId, '4');
assert.equal(inventory.activeActor.type, 'wayland');
assert.equal(inventory.activeActor.authenticatedBySessionManager, false);
assert.equal(calls.some(call => call.args.includes('../../evil')), false);
assert.equal(calls.every(call => ['list-sessions', 'show-session'].includes(call.args[0])), true);
assert.equal(calls.some(call => call.args.some(arg => /terminate|kill|lock|unlock|activate-linger/.test(arg))), false);

const seat1 = selectActiveLocalSession(inventory, { preferredSeat: 'seat1' });
assert.equal(seat1.actorId, 'uid:1002');
assert.equal(seat1.sessionId, '3');

const actor = await service.resolveActiveActor();
assert.equal(actor.username, 'alice');
const context = createSessionBoundAuthorizationContext(actor, { currentUid: 1000, allowUserInteraction: true });
assert.deepEqual(context, { actorId: 'uid:1000', sessionId: '4', allowUserInteraction: true });
assert.throws(() => createSessionBoundAuthorizationContext(actor, { currentUid: 0 }), error => error.code === 'SESSION_PROCESS_UID_MISMATCH');

const emptyService = new SystemSessionIdentityService({
  binary: '/test/loginctl',
  enforceBinaryTrust: false,
  expectedOwnerUid: null,
  runner: async (_binary, args, options) => {
    assert.equal(options.shell, false);
    if (args[0] === 'list-sessions') return { code: 0, stdout: '', stderr: '' };
    throw new Error('show-session must not run for empty inventory');
  }
});
assert.equal(await emptyService.resolveActiveActor({ required: false }), null);
await assert.rejects(() => emptyService.resolveActiveActor(), error => error.code === 'NO_ACTIVE_LOCAL_SESSION');

const unavailable = new SystemSessionIdentityService({
  binary: '/test/loginctl', enforceBinaryTrust: false, expectedOwnerUid: null,
  runner: async () => ({ code: 0, stdout: '', stderr: '' })
});
assert.equal((await unavailable.probe()).available, true);

assert.equal(SystemSessionIdentityPolicy.readOnly, true);
assert.equal(SystemSessionIdentityPolicy.mutationCapable, false);
assert.equal(SystemSessionIdentityPolicy.remoteSessionEligible, false);
assert.equal(SystemSessionIdentityPolicy.rootSessionEligible, false);
assert.equal(SystemSessionIdentityPolicy.shellExecution, false);
assert.equal(SystemSessionIdentityPolicy.secretCollection, false);

console.log('System session identity self-test: OK');
console.log(`Sessions observed: ${inventory.sessions.length}; selected actor: ${inventory.activeActor.actorId} (${inventory.activeActor.type}/${inventory.activeActor.seat})`);
