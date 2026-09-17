import assert from 'node:assert/strict';
import { SystemSessionIdentityService } from './system-session-identity-service.mjs';

function makeRunner(sessionMap, listed = Object.keys(sessionMap)) {
  return async (_binary, args, options) => {
    assert.equal(options.shell, false);
    assert.equal(options.env.PATH, '/usr/sbin:/usr/bin:/sbin:/bin');
    if (args[0] === 'list-sessions') {
      return { stdout: listed.map(id => `${id} 1000 demo seat0 tty2`).join('\n') + '\n', stderr: '', code: 0 };
    }
    if (args[0] === 'show-session') {
      const session = sessionMap[args[1]];
      if (!session) return { stdout: '', stderr: 'missing', code: 1 };
      return { stdout: Object.entries(session).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', stderr: '', code: 0 };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
}

const active = {
  Id: '2', User: '1000', Name: 'swir', Remote: 'no', Active: 'yes', State: 'active', Class: 'user', Type: 'wayland', Seat: 'seat0', Display: ':0', LockedHint: 'no'
};
const remote = {
  Id: '9', User: '1001', Name: 'remote', Remote: 'yes', Active: 'yes', State: 'active', Class: 'user', Type: 'x11', Seat: 'seat0', Display: ':9', LockedHint: 'no'
};
const inactive = {
  Id: '10', User: '1002', Name: 'idle', Remote: 'no', Active: 'no', State: 'online', Class: 'user', Type: 'wayland', Seat: 'seat0', Display: ':10', LockedHint: 'yes'
};

const service = new SystemSessionIdentityService({
  binary: '/test/loginctl',
  runner: makeRunner({ 2: active, 9: remote, 10: inactive }),
  enforceBinaryTrust: false
});
const inventory = await service.inventory();
assert.equal(inventory.schema, 'swir.system-session-inventory/0.1');
assert.equal(inventory.readOnly, true);
assert.equal(inventory.secretsExposed, false);
assert.equal(inventory.sessions.length, 3);
assert.equal(inventory.sessions.find(item => item.id === '2').eligible, true);
assert.equal(inventory.sessions.find(item => item.id === '9').eligible, false);
assert.equal(inventory.sessions.find(item => item.id === '10').eligible, false);

const identity = await service.resolveActiveSession();
assert.equal(identity.schema, 'swir.system-session-identity/0.1');
assert.equal(identity.actorId, 'uid:1000');
assert.equal(identity.sessionId, '2');
assert.equal(identity.seat, 'seat0');
assert.equal(identity.graphical, true);
assert.equal(identity.remote, false);
assert.equal(identity.locked, false);

await service.assertActorBinding({ actorId: 'uid:1000', sessionId: '2' });
await assert.rejects(() => service.assertActorBinding({ actorId: 'uid:1001', sessionId: '2' }), error => error?.code === 'SESSION_ACTOR_MISMATCH');
await assert.rejects(() => service.assertActorBinding({ actorId: 'uid:1000', sessionId: '9' }), error => error?.code === 'SESSION_ID_MISMATCH');

const remoteOnly = new SystemSessionIdentityService({ binary: '/test/loginctl', runner: makeRunner({ 9: remote }), enforceBinaryTrust: false });
await assert.rejects(() => remoteOnly.resolveActiveSession(), error => error?.code === 'NO_ACTIVE_LOCAL_SESSION');

const tty = { ...active, Id: '3', Type: 'tty', Display: '' };
const ttyService = new SystemSessionIdentityService({ binary: '/test/loginctl', runner: makeRunner({ 3: tty }), enforceBinaryTrust: false });
await assert.rejects(() => ttyService.resolveActiveSession(), error => error?.code === 'NO_ACTIVE_LOCAL_SESSION');
const ttyIdentity = await ttyService.resolveActiveSession({ requireGraphical: false });
assert.equal(ttyIdentity.sessionId, '3');
assert.equal(ttyIdentity.graphical, false);

const another = { ...active, Id: '4', User: '1003', Name: 'other', Display: ':1' };
const ambiguous = new SystemSessionIdentityService({ binary: '/test/loginctl', runner: makeRunner({ 2: active, 4: another }), enforceBinaryTrust: false });
await assert.rejects(() => ambiguous.resolveActiveSession(), error => error?.code === 'AMBIGUOUS_ACTIVE_SESSION');

const lowUid = { ...active, Id: '5', User: '500', Name: 'service' };
const lowUidService = new SystemSessionIdentityService({ binary: '/test/loginctl', runner: makeRunner({ 5: lowUid }), enforceBinaryTrust: false });
await assert.rejects(() => lowUidService.resolveActiveSession(), error => error?.code === 'NO_ACTIVE_LOCAL_SESSION');

console.log('System session identity self-test OK');
