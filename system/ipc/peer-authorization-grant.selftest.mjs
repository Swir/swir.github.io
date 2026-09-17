import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeerAuthorizationGrantVerifier, PeerPackageAuthorizationBroker, PeerNetworkAuthorizationBroker, PeerFirmwareAuthorizationBroker, stableStringify, PeerAuthorizationPolicy } from './peer-authorization-grant.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-peer-grant-'));
const keyPath = path.join(temp, 'peer.key');
const key = crypto.randomBytes(32);
fs.writeFileSync(keyPath, key, { mode: 0o600 }); fs.chmodSync(keyPath, 0o600);
const now = 1_800_000_000_000; let counter = 0;
function envelope(extra = {}, { issuedAtMs = now, expiresAtMs = now + 10_000 } = {}) {
  counter += 1;
  const payload = { schema: 'swir.peer-authorization-grant/0.1', issuer: 'swir-peer-authorization-broker', audience: 'swir-system-privileged-services', grantId: `grant_${String(counter).padStart(20, '0')}`, authorized: true,
    scope: 'packages.mutate', actionId: 'org.swir.system.packages.mutate', planDigest: 'a'.repeat(64), operation: 'install', actorId: 'uid:1000',
    subject: { pid: 4242, uid: 1000, gid: 1000, startTime: '987654' }, session: { id: 'c1', uid: 1000, username: 'tester', seat: 'seat0', type: 'wayland', local: true, active: true },
    interactive: false, issuedAtMs, expiresAtMs, packageId: 'org.swir.test', ...extra };
  const mac = crypto.createHmac('sha256', key).update(stableStringify(payload), 'utf8').digest('hex'); return { schema: 'swir.peer-authorization-envelope/0.1', payload, mac };
}
function verifier() { return new PeerAuthorizationGrantVerifier({ keyPath, clock: () => now, allowTestOwner: true }); }
const packageExpected = { schema: 'swir.peer-authorization-request/0.1', scope: 'packages.mutate', planDigest: 'a'.repeat(64), packageId: 'org.swir.test', operation: 'install', allowUserInteraction: false };
const grant = verifier().verify(envelope(), packageExpected); assert.equal(grant.actorId, 'uid:1000'); assert.equal(grant.session.id, 'c1'); assert.equal(grant.subject.pid, 4242);
const replayVerifier = verifier(); const replayEnvelope = envelope(); replayVerifier.verify(replayEnvelope, packageExpected); assert.throws(() => replayVerifier.verify(replayEnvelope, packageExpected), error => error.code === 'GRANT_REPLAYED');
const tampered = envelope(); tampered.payload.packageId = 'org.swir.other'; assert.throws(() => verifier().verify(tampered, packageExpected), error => error.code === 'GRANT_MAC_MISMATCH');
assert.throws(() => verifier().verify(envelope(), { ...packageExpected, planDigest: 'b'.repeat(64) }), error => error.code === 'GRANT_PLAN_MISMATCH');
assert.throws(() => verifier().verify(envelope({}, { issuedAtMs: now - 40_000, expiresAtMs: now - 30_000 }), packageExpected), error => error.code === 'GRANT_EXPIRED');
assert.throws(() => verifier().verify(envelope({}, { issuedAtMs: now, expiresAtMs: now + 45_000 }), packageExpected), error => error.code === 'INVALID_GRANT_TTL');
const packageBroker = new PeerPackageAuthorizationBroker({ verifier: verifier() });
const packageResult = await packageBroker.authorize({ schema: 'swir.system-authorization-request/0.1', scope: 'packages.mutate', planDigest: 'a'.repeat(64), packageId: 'org.swir.test', operation: 'install', context: { actorId: 'uid:1000', allowUserInteraction: false, peerAuthorizationEnvelope: envelope() } });
assert.equal(packageResult.schema, 'swir.system-authorization-grant/0.1'); assert.equal(packageResult.peerCredentialBound, true); assert.equal(packageResult.sessionId, 'c1');
const networkVerifier = verifier(); const networkPayload = envelope({ scope: 'network.activate', actionId: 'org.swir.system.network.activate', operation: 'activate', connectionUuid: '123e4567-e89b-12d3-a456-426614174000', ifname: 'wlan0', packageId: undefined }); delete networkPayload.payload.packageId; networkPayload.mac = crypto.createHmac('sha256', key).update(stableStringify(networkPayload.payload), 'utf8').digest('hex');
const networkBroker = new PeerNetworkAuthorizationBroker({ verifier: networkVerifier }); const networkResult = await networkBroker.authorize({ schema: 'swir.network-authorization-request/0.1', operation: 'activate', planDigest: 'a'.repeat(64), connectionUuid: '123e4567-e89b-12d3-a456-426614174000', ifname: 'wlan0', context: { actorId: 'uid:1000', allowUserInteraction: false, peerAuthorizationEnvelope: networkPayload } }); assert.equal(networkResult.schema, 'swir.network-authorization-grant/0.1');
const firmwarePayload = envelope({ scope: 'firmware.update', actionId: 'org.swir.system.firmware.update', operation: 'update', deviceId: 'UEFI-test-device', releaseId: 'release-2', packageId: undefined }); delete firmwarePayload.payload.packageId; firmwarePayload.mac = crypto.createHmac('sha256', key).update(stableStringify(firmwarePayload.payload), 'utf8').digest('hex');
const firmwareBroker = new PeerFirmwareAuthorizationBroker({ verifier: verifier() }); const firmwareResult = await firmwareBroker.authorize({ schema: 'swir.firmware-authorization-request/0.1', operation: 'update', planDigest: 'a'.repeat(64), deviceId: 'UEFI-test-device', releaseId: 'release-2', context: { actorId: 'uid:1000', allowUserInteraction: false, peerAuthorizationEnvelope: firmwarePayload } }); assert.equal(firmwareResult.schema, 'swir.firmware-authorization-grant/0.1');
fs.chmodSync(keyPath, 0o644); assert.throws(() => verifier().verify(envelope(), packageExpected), error => error.code === 'AUTH_KEY_MODE_INVALID');
assert.equal(PeerAuthorizationPolicy.peerIdentitySource, 'linux-so-peercred'); assert.equal(PeerAuthorizationPolicy.callerSuppliedUnixIdentity, false); assert.equal(PeerAuthorizationPolicy.oneTimeConsumption, true);
fs.rmSync(temp, { recursive: true, force: true }); console.log('Peer authorization grant self-test: OK');
