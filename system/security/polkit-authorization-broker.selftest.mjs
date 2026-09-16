import assert from 'node:assert/strict';
import { PolkitSystemAuthorizationBroker, PolkitAuthorizationError, validateSystemAuthorizationRequest } from './polkit-authorization-broker.mjs';

const digest = 'a'.repeat(64);
const baseRequest = {
  schema: 'swir.system-authorization-request/0.1',
  scope: 'packages.mutate',
  planDigest: digest,
  packageId: 'swir.example',
  operation: 'install',
  context: {}
};

function trustedStat(overrides = {}) {
  return { isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100755, ...overrides };
}

const calls = [];
const broker = new PolkitSystemAuthorizationBroker({
  processProbe: async () => ({ pid: 4242, uid: 1000, startTime: '987654' }),
  fileProbe: () => trustedStat(),
  runner: async (command, args, options) => {
    calls.push({ command, args, options });
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  },
  clock: () => '2026-09-16T21:00:00.000Z',
  grantIdFactory: () => 'grant:system:0001'
});

const grant = await broker.authorize(baseRequest);
assert.equal(grant.authorized, true);
assert.equal(grant.schema, 'swir.system-authorization-grant/0.1');
assert.equal(grant.actorId, 'uid:1000');
assert.equal(grant.actionId, 'org.swir.system.packages.mutate');
assert.equal(grant.planDigest, digest);
assert.deepEqual(grant.subject, { pid: 4242, uid: 1000, startTime: '987654' });
assert.equal(calls.length, 1);
assert.equal(calls[0].command, '/usr/bin/pkcheck');
assert.equal(calls[0].args.includes('--allow-user-interaction'), false);
assert.deepEqual(calls[0].options.env, { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
assert.ok(calls[0].args.includes('4242,987654,1000'));
assert.ok(calls[0].args.includes('swir.planDigest'));
assert.ok(calls[0].args.includes(digest));

const interactiveCalls = [];
const interactive = new PolkitSystemAuthorizationBroker({
  processProbe: () => ({ pid: 11, uid: 1001, startTime: '222' }),
  fileProbe: () => trustedStat(),
  runner: (command, args) => {
    interactiveCalls.push({ command, args });
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  },
  grantIdFactory: () => 'grant:system:0002'
});
await interactive.authorize({ ...baseRequest, context: { actorId: 'uid:1001', allowUserInteraction: true } });
assert.ok(interactiveCalls[0].args.includes('--allow-user-interaction'));

const denied = new PolkitSystemAuthorizationBroker({
  processProbe: () => ({ pid: 10, uid: 1002, startTime: '333' }),
  fileProbe: () => trustedStat(),
  runner: () => ({ exitCode: 1, signal: null, stdout: '', stderr: 'Not authorized' })
});
const denial = await denied.authorize({ ...baseRequest, scope: 'packages.recover' });
assert.equal(denial.authorized, false);
assert.equal(denial.reason, 'not-authorized');
assert.equal(denial.actionId, 'org.swir.system.packages.recover');

await assert.rejects(
  () => broker.authorize({ ...baseRequest, context: { actorId: 'uid:9999' } }),
  error => error instanceof PolkitAuthorizationError && error.code === 'ACTOR_BINDING_MISMATCH'
);

assert.throws(
  () => validateSystemAuthorizationRequest({ ...baseRequest, planDigest: 'ABC' }),
  error => error instanceof PolkitAuthorizationError && error.code === 'INVALID_PLAN_DIGEST'
);
assert.throws(
  () => validateSystemAuthorizationRequest({ ...baseRequest, scope: 'system.root' }),
  error => error instanceof PolkitAuthorizationError && error.code === 'UNSUPPORTED_AUTHORIZATION_SCOPE'
);

const unsafeBinary = new PolkitSystemAuthorizationBroker({
  processProbe: () => ({ pid: 1, uid: 1000, startTime: '1' }),
  fileProbe: () => trustedStat({ mode: 0o100777 }),
  runner: () => { throw new Error('must not run'); }
});
await assert.rejects(
  () => unsafeBinary.authorize(baseRequest),
  error => error instanceof PolkitAuthorizationError && error.code === 'UNTRUSTED_POLKIT_BINARY_MODE'
);

console.log('SWIR Polkit authorization broker self-test OK');
