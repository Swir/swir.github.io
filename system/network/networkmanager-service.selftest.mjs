import assert from 'node:assert/strict';
import { NetworkManagerPolicy, NetworkManagerService, assertSafeNetworkManagerInventory } from './networkmanager-service.mjs';
import { PolkitNetworkAuthorizationBroker, validateNetworkAuthorizationRequest } from '../security/polkit-network-authorization-broker.mjs';

const uuid = '123e4567-e89b-42d3-a456-426614174000';
const calls = [];
let active = false;
const runner = async (binary, args, options) => {
  calls.push({ binary, args: [...args], options });
  const joined = args.join(' ');
  if (joined.includes('general status')) return { stdout: 'connected:full:enabled:enabled:enabled:disabled\n', stderr: '', code: 0 };
  if (joined.includes('device status')) return { stdout: 'wlp2s0:wifi:connected:Home\\:LAN\nenp3s0:ethernet:disconnected:--\n', stderr: '', code: 0 };
  if (joined.includes('connection show --active')) return { stdout: active ? `${uuid}\n` : '', stderr: '', code: 0 };
  if (joined.includes('--fields UUID') && joined.includes('connection show')) return { stdout: `${uuid}\n`, stderr: '', code: 0 };
  if (joined.includes('connection show')) return { stdout: `Home\\:LAN:${uuid}:802-11-wireless:wlp2s0\n`, stderr: '', code: 0 };
  if (joined.includes('device wifi list')) return { stdout: '*:AA\\:BB\\:CC\\:DD\\:EE\\:FF:Home\\:LAN:83:WPA2:wlp2s0\n', stderr: '', code: 0 };
  if (joined.includes('connection up uuid')) { active = true; return { stdout: 'activated\n', stderr: '', code: 0 }; }
  if (joined.includes('connection down uuid')) { active = false; return { stdout: 'deactivated\n', stderr: '', code: 0 }; }
  throw new Error(`unexpected nmcli args: ${joined}`);
};

const grants = [];
const authorizer = {
  async authorize(request) {
    grants.push(request);
    return {
      schema: 'swir.network-authorization-grant/0.1',
      authorized: true,
      actionId: `org.swir.system.network.${request.operation}`,
      actorId: 'uid:1000',
      operation: request.operation,
      connectionUuid: request.connectionUuid,
      ifname: request.ifname ?? null,
      planDigest: request.planDigest
    };
  }
};

const service = new NetworkManagerService({ binary: '/test/nmcli', runner, authorizer, enforceBinaryTrust: false });
const inventory = await service.inventory();
assert.equal(inventory.available, true);
assert.equal(inventory.secretsExposed, false);
assert.equal(inventory.general.connectivity, 'full');
assert.equal(inventory.devices[0].connection, 'Home:LAN');
assert.equal(inventory.connections[0].name, 'Home:LAN');
assert.equal(inventory.connections[0].uuid, uuid);
assert.equal(inventory.accessPoints[0].bssid, 'AA:BB:CC:DD:EE:FF');
assert.equal(inventory.accessPoints[0].ssid, 'Home:LAN');
assert.equal(inventory.accessPoints[0].secretExposed, false);
assertSafeNetworkManagerInventory(inventory);

const activatePlan = service.planActivation({ connectionUuid: uuid, ifname: 'wlp2s0' });
assert.equal(activatePlan.command.join(' '), `connection up uuid ${uuid} ifname wlp2s0`);
assert.match(activatePlan.digest, /^[a-f0-9]{64}$/);
const activated = await service.activateExistingProfile({ connectionUuid: uuid, ifname: 'wlp2s0' }, { actorId: 'uid:1000' });
assert.equal(activated.active, true);
assert.equal(activated.postconditionVerified, true);
assert.equal(grants[0].planDigest, activatePlan.digest);

const deactivated = await service.deactivateProfile({ connectionUuid: uuid }, { actorId: 'uid:1000' });
assert.equal(deactivated.active, false);
assert.equal(deactivated.postconditionVerified, true);
assert.equal(grants.length, 2);

assert.equal(NetworkManagerPolicy.showSecrets, false);
assert.equal(NetworkManagerPolicy.createProfile, false);
assert.equal(NetworkManagerPolicy.rawArguments, false);
assert.equal(calls.every(call => call.options.shell === false), true);
assert.equal(calls.some(call => call.args.includes('--show-secrets')), false);

await assert.rejects(() => service.activateExistingProfile({ connectionUuid: 'not-a-uuid' }), error => error.code === 'INVALID_CONNECTION_UUID');
await assert.rejects(() => service.activateExistingProfile({ connectionUuid: uuid, ifname: 'wlan0;sh' }), error => error.code === 'INVALID_INTERFACE_NAME');
await assert.rejects(() => service.activateExistingProfile({ connectionUuid: '223e4567-e89b-42d3-a456-426614174000' }, { actorId: 'uid:1000' }), error => error.code === 'NETWORK_CONNECTION_NOT_FOUND');

const denied = new NetworkManagerService({
  binary: '/test/nmcli',
  runner,
  enforceBinaryTrust: false,
  authorizer: { authorize: async request => ({ schema: 'swir.network-authorization-grant/0.1', authorized: false, operation: request.operation, connectionUuid: request.connectionUuid, planDigest: request.planDigest }) }
});
await assert.rejects(() => denied.activateExistingProfile({ connectionUuid: uuid }), error => error.code === 'NETWORK_AUTHORIZATION_DENIED');

const brokerCalls = [];
assert.throws(() => new PolkitNetworkAuthorizationBroker({ pkcheckPath: '/tmp/pkcheck' }), error => error.code === 'INVALID_POLKIT_PATH');

const broker = new PolkitNetworkAuthorizationBroker({
  pkcheckPath: '/usr/bin/pkcheck',
  fileProbe: () => ({ isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100755 }),
  processProbe: async () => ({ pid: 4242, uid: 1000, startTime: '987654' }),
  runner: async (command, args) => { brokerCalls.push({ command, args }); return { exitCode: 0, stdout: '', stderr: '' }; },
  grantIdFactory: () => 'network-grant-0001',
  clock: () => '2026-09-17T01:00:00.000Z'
});
const request = validateNetworkAuthorizationRequest({
  schema: 'swir.network-authorization-request/0.1',
  operation: 'activate', connectionUuid: uuid, ifname: 'wlp2s0', planDigest: 'a'.repeat(64), context: { actorId: 'uid:1000' }
});
const grant = await broker.authorize(request);
assert.equal(grant.authorized, true);
assert.equal(grant.actorId, 'uid:1000');
assert.equal(grant.connectionUuid, uuid);
assert.equal(brokerCalls.length, 1);
assert.equal(brokerCalls[0].command, '/usr/bin/pkcheck');
assert.equal(brokerCalls[0].args.includes('--allow-user-interaction'), false);
assert.equal(brokerCalls[0].args.includes('org.swir.system.network.activate'), true);

await assert.rejects(() => broker.authorize({ ...request, context: { actorId: 'uid:999' } }), error => error.code === 'ACTOR_BINDING_MISMATCH');

console.log('NetworkManager service self-test: OK');
