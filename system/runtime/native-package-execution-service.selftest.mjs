import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { buildNativeLaunchRequest, NativePackageExecutionService, NativePackageExecutionPolicy } from './native-package-execution-service.mjs';

assert.equal(NativePackageExecutionPolicy.trustVerifiedRequired, true);
assert.equal(NativePackageExecutionPolicy.signatureRequired, true);
assert.equal(NativePackageExecutionPolicy.shellExecution, false);

const executable = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
const manifest = {
  schema: 'swir.package-provider/0.2',
  id: 'swir.selftest.native-package',
  targetEditions: ['system'],
  executionClass: 'linux-native',
  provider: 'swir.package.system',
  package: { name: 'Self Test', nativeEntryPoint: executable },
  trust: { sourceClass: 'swir-signed', signatureRequired: true },
  rollback: true
};

const request = buildNativeLaunchRequest(manifest, { trustVerified: true, args: ['--version'] });
assert.equal(request.appId, manifest.id);
assert.equal(request.executable, executable);
assert.deepEqual(request.args, ['--version']);
assert.throws(() => buildNativeLaunchRequest(manifest), /trust must be verified/);
assert.throws(() => buildNativeLaunchRequest({ ...manifest, targetEditions: ['desktop'] }, { trustVerified: true }), /does not target System Edition/);
assert.throws(() => buildNativeLaunchRequest({ ...manifest, executionClass: 'windows-compat', provider: 'swir.compat.wine' }, { trustVerified: true }), /linux-native only/);
assert.throws(() => buildNativeLaunchRequest({ ...manifest, trust: { ...manifest.trust, signatureRequired: false } }, { trustVerified: true }), /must require signature verification/);
assert.throws(() => buildNativeLaunchRequest({ ...manifest, package: { ...manifest.package, nativeEntryPoint: 'relative/app' } }, { trustVerified: true }), /absolute path/);

if (fs.existsSync(executable)) {
  const service = new NativePackageExecutionService();
  const exited = once(service, 'exited');
  const started = service.launch(manifest, { trustVerified: true, environment: { PATH: '/usr/bin:/bin', HOME: '/tmp' } });
  assert.equal(started.appId, manifest.id);
  assert.equal(started.state, 'running');
  const [finished] = await exited;
  assert.equal(finished.state, 'exited');
  assert.equal(finished.exitCode, 0);
  assert.equal(service.forget(manifest.id), true);
}

console.log('SWIR native package execution service self-tests: OK');
