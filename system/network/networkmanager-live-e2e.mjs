import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  NetworkManagerService,
  NetworkManagerPolicy,
  assertSafeNetworkManagerInventory
} from './networkmanager-service.mjs';

const UUID = '7c3d5747-91f7-4dd6-8c41-78c9bc407e17';
const IFNAME = 'swir0';
const CONNECTION_NAME = 'swir-e2e';

function fail(code, message) {
  const error = new Error(message);
  error.name = 'NetworkManagerLiveE2EError';
  error.code = code;
  throw error;
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function parseArgs(argv) {
  const out = { output: null, compact: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--compact') out.compact = true;
    else if (arg === '--output') {
      out.output = argv[++i] || null;
      assert(out.output, 'OUTPUT_REQUIRED', '--output requires a path');
    } else fail('UNKNOWN_ARGUMENT', `Unsupported argument: ${arg}`);
  }
  return out;
}

function authorizer() {
  const grants = [];
  return {
    grants,
    async authorize(request) {
      assert(request?.schema === 'swir.network-authorization-request/0.1', 'AUTH_SCHEMA_INVALID', 'Unexpected network authorization request schema');
      assert(request.connectionUuid === UUID, 'AUTH_UUID_MISMATCH', 'Authorization request is not bound to the isolated E2E profile');
      assert(request.operation === 'activate' || request.operation === 'deactivate', 'AUTH_OPERATION_INVALID', 'Unsupported E2E authorization operation');
      assert(/^[a-f0-9]{64}$/.test(request.planDigest || ''), 'AUTH_DIGEST_INVALID', 'Authorization request lacks a plan digest');
      const grant = Object.freeze({
        schema: 'swir.network-authorization-grant/0.1',
        authorized: true,
        actionId: `org.swir.system.network.${request.operation}`,
        actorId: 'e2e:isolated-network-namespace',
        operation: request.operation,
        connectionUuid: request.connectionUuid,
        ifname: request.ifname ?? null,
        planDigest: request.planDigest
      });
      grants.push(grant);
      return grant;
    }
  };
}

export async function runNetworkManagerLiveE2E() {
  assert(process.platform === 'linux', 'LINUX_REQUIRED', 'NetworkManager live E2E requires Linux');
  const auth = authorizer();
  const service = new NetworkManagerService({ authorizer: auth });

  const probe = await service.probe();
  assert(probe.available === true && probe.trustedBinary === true, 'NMCLI_NOT_TRUSTED', 'Production /usr/bin/nmcli trust probe failed');
  assert(probe.ownerUid === 0, 'NMCLI_NOT_ROOT_OWNED', 'Production nmcli must be root-owned');

  const before = await service.inventory({ includeWifi: false });
  assertSafeNetworkManagerInventory(before);
  assert(before.available === true && before.provider === 'NetworkManager', 'NETWORKMANAGER_UNAVAILABLE', 'NetworkManager inventory is unavailable');
  assert(before.secretsExposed === false, 'NETWORK_SECRET_EXPOSURE', 'NetworkManager inventory exposed secrets');
  const profile = before.connections.find(item => item.uuid === UUID);
  assert(profile, 'E2E_PROFILE_NOT_FOUND', 'Isolated NetworkManager E2E profile is missing');
  assert(profile.name === CONNECTION_NAME, 'E2E_PROFILE_NAME_MISMATCH', 'Unexpected isolated E2E profile name');
  assert(before.devices.some(device => device.ifname === IFNAME), 'E2E_DEVICE_NOT_FOUND', 'Isolated dummy interface is missing from NetworkManager inventory');

  const activatePlan = service.planActivation({ connectionUuid: UUID, ifname: IFNAME });
  assert(activatePlan.operation === 'activate' && /^[a-f0-9]{64}$/.test(activatePlan.digest), 'ACTIVATE_PLAN_INVALID', 'Activation plan is invalid');
  const activated = await service.activateExistingProfile({ connectionUuid: UUID, ifname: IFNAME }, { actorId: 'e2e:isolated-network-namespace' });
  assert(activated.active === true && activated.postconditionVerified === true, 'ACTIVATION_POSTCONDITION_FAILED', 'Real NetworkManager activation postcondition failed');

  const activeInventory = await service.inventory({ includeWifi: false });
  assertSafeNetworkManagerInventory(activeInventory);
  const activeProfile = activeInventory.connections.find(item => item.uuid === UUID);
  assert(activeProfile?.active === true, 'ACTIVATION_NOT_VISIBLE', 'Activated profile is not visible as active in NetworkManager inventory');

  const deactivatePlan = service.planDeactivation({ connectionUuid: UUID });
  assert(deactivatePlan.operation === 'deactivate' && /^[a-f0-9]{64}$/.test(deactivatePlan.digest), 'DEACTIVATE_PLAN_INVALID', 'Deactivation plan is invalid');
  const deactivated = await service.deactivateProfile({ connectionUuid: UUID }, { actorId: 'e2e:isolated-network-namespace' });
  assert(deactivated.active === false && deactivated.postconditionVerified === true, 'DEACTIVATION_POSTCONDITION_FAILED', 'Real NetworkManager deactivation postcondition failed');
  assert(auth.grants.length === 2, 'AUTHORIZATION_COUNT_INVALID', 'Expected one exact grant per mutation');
  assert(auth.grants[0].planDigest === activatePlan.digest && auth.grants[1].planDigest === deactivatePlan.digest, 'AUTHORIZATION_BINDING_FAILED', 'Mutation grants are not bound to exact plan digests');

  const after = await service.inventory({ includeWifi: false });
  assertSafeNetworkManagerInventory(after);
  assert(after.connections.find(item => item.uuid === UUID)?.active === false, 'DEACTIVATION_NOT_VISIBLE', 'Deactivated profile is still visible as active');

  assert(NetworkManagerPolicy.showSecrets === false, 'SECRET_POLICY_WEAK', 'NetworkManager policy must keep secret display disabled');
  assert(NetworkManagerPolicy.createProfile === false, 'PROFILE_CREATION_POLICY_WEAK', 'Applications must not create arbitrary profiles through the guarded service');
  assert(NetworkManagerPolicy.rawArguments === false, 'RAW_ARGUMENT_POLICY_WEAK', 'Raw nmcli arguments must remain disabled');

  return {
    schema: 'swir.networkmanager-live-e2e/0.1',
    generatedAt: new Date().toISOString(),
    provider: 'NetworkManager',
    binary: probe.binary,
    binaryTrusted: probe.trustedBinary,
    binaryOwnerUid: probe.ownerUid,
    namespace: 'isolated-linux-network-namespace',
    externalNetworkRequired: false,
    testInterface: IFNAME,
    connectionUuid: UUID,
    inventoryReadOnly: true,
    secretsExposed: false,
    activationVerified: true,
    deactivationVerified: true,
    authorizationPlanDigestBound: true,
    realNmcliExecution: true,
    rawArgumentsExposed: false,
    arbitraryProfileCreationExposed: false,
    productionPolkitBoundaryTestedSeparately: true,
    hostNetworkMutationClaim: false,
    passed: true
  };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const evidence = await runNetworkManagerLiveE2E();
    const json = JSON.stringify(evidence, null, args.compact ? 0 : 2) + '\n';
    if (args.output) fs.writeFileSync(args.output, json, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(json);
  } catch (error) {
    process.stderr.write(`${error?.code || error?.name || 'ERROR'}: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
