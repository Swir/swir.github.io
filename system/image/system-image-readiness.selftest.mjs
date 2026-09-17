import assert from 'node:assert/strict';
import { SystemImageReadinessPolicy, evaluateSystemImageReadiness } from './system-image-readiness.mjs';

function binary(provider, path) {
  return { selected: { provider, path, realPath: path, available: true, trusted: true }, observed: [] };
}

const healthy = {
  schema: 'swir.system-image-host-evidence/0.1', readOnly: true, collectedAt: '2026-09-17T01:00:00Z',
  platform: 'linux', architecture: 'x64', kernelRelease: '6.14.0-test',
  distribution: { id: 'ubuntu', versionId: '24.04', prettyName: 'Ubuntu 24.04 LTS' },
  filesystems: { proc: { available: true }, sys: { available: true } },
  catalogState: { path: '/var/lib/swir/security/catalog-trust', available: true, trusted: true, modeOk: true },
  binaries: {
    packageManager: binary('apt', '/usr/bin/apt-get'), serviceManager: binary('systemd', '/usr/bin/systemctl'), polkit: binary('polkit', '/usr/bin/pkcheck'),
    networkManager: binary('NetworkManager', '/usr/bin/nmcli'), fwupd: binary('fwupd', '/usr/bin/fwupdmgr'), flatpak: binary('flatpak', '/usr/bin/flatpak'), wine: binary('wine', '/usr/bin/wine')
  }
};

const ready = evaluateSystemImageReadiness(healthy);
assert.equal(ready.summary.systemImageReadyForE2E, true);
assert.equal(ready.summary.baseReady, true);
assert.equal(ready.summary.securityReady, true);
assert.equal(ready.summary.networkReady, true);
assert.deepEqual(ready.summary.blockers, []);
assert.equal(ready.summary.requiredPassed, ready.summary.requiredTotal);
assert.equal(ready.summary.optionalPassed, 3);

const missingSecurity = structuredClone(healthy);
missingSecurity.catalogState.trusted = false;
missingSecurity.binaries.polkit.selected = null;
const blocked = evaluateSystemImageReadiness(missingSecurity);
assert.equal(blocked.summary.systemImageReadyForE2E, false);
assert.equal(blocked.summary.baseReady, true);
assert.equal(blocked.summary.securityReady, false);
assert.deepEqual(blocked.summary.blockers.sort(), ['catalog-trust-state-root', 'polkit-broker']);

const optionalMissing = structuredClone(healthy);
optionalMissing.binaries.fwupd.selected = null;
optionalMissing.binaries.flatpak.selected = null;
optionalMissing.binaries.wine.selected = null;
const stillCoreReady = evaluateSystemImageReadiness(optionalMissing);
assert.equal(stillCoreReady.summary.systemImageReadyForE2E, true);
assert.equal(stillCoreReady.summary.optionalPassed, 0);

assert.throws(() => evaluateSystemImageReadiness({ ...healthy, readOnly: false }), /read-only host evidence/);
assert.equal(SystemImageReadinessPolicy.bootableImageClaim, false);
assert.equal(SystemImageReadinessPolicy.mutationPerformed, false);
console.log('System image readiness self-test: OK');
