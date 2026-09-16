import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  WindowsCompatibilityPolicy,
  WindowsCompatibilityService,
  buildCompatibilityLaunchPlan,
  managedPrefixPath,
  prepareManagedPrefix,
  sanitizeCompatibilityEnvironment,
  validateCompatibilityManifest
} from './windows-compatibility-service.mjs';

assert.equal(WindowsCompatibilityPolicy.trustVerifiedRequired, true);
assert.equal(WindowsCompatibilityPolicy.signatureRequired, true);
assert.equal(WindowsCompatibilityPolicy.brokerRequired, true);
assert.equal(WindowsCompatibilityPolicy.shellExecution, false);
assert.equal(WindowsCompatibilityPolicy.prefixPolicy, 'per-app');
assert.deepEqual(new Set(WindowsCompatibilityPolicy.providers), new Set(['swir.compat.wine', 'swir.compat.proton']));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-compat-'));
const prefixRoot = path.join(temp, 'prefixes');
const runtimeRoot = path.join(temp, 'runtimes');
fs.mkdirSync(runtimeRoot, { recursive: true });
const fakeRuntime = path.join(runtimeRoot, 'wine-runtime');
fs.writeFileSync(fakeRuntime, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const baseManifest = {
  schema: 'swir.package-provider/0.2',
  id: 'swir.selftest.windows-app',
  targetEditions: ['system'],
  executionClass: 'windows-compat',
  provider: 'swir.compat.wine',
  package: { name: 'Windows Self Test', nativeEntryPoint: path.join(prefixRoot, 'swir.selftest.windows-app', 'drive_c', 'Program Files', 'SelfTest', 'app.exe') },
  compatibility: { prefixPolicy: 'per-app', windowsArchitecture: 'win64', runtimeChannel: 'stable' },
  trust: { sourceClass: 'swir-signed', signatureRequired: true },
  rollback: true
};

assert.equal(validateCompatibilityManifest(baseManifest, { trustVerified: true }).family, 'wine');
assert.throws(() => validateCompatibilityManifest(baseManifest), /trust must be verified/);
assert.throws(() => validateCompatibilityManifest({ ...baseManifest, executionClass: 'linux-native' }, { trustVerified: true }), /windows-compat only/);
assert.throws(() => validateCompatibilityManifest({ ...baseManifest, targetEditions: ['desktop'] }, { trustVerified: true }), /does not target System Edition/);
assert.throws(() => validateCompatibilityManifest({ ...baseManifest, provider: 'swir.package.system' }, { trustVerified: true }), /unsupported Windows compatibility provider/);
assert.throws(() => validateCompatibilityManifest({ ...baseManifest, compatibility: { ...baseManifest.compatibility, prefixPolicy: 'shared-explicit' } }, { trustVerified: true }), /only per-app/);
assert.throws(() => validateCompatibilityManifest({ ...baseManifest, trust: { ...baseManifest.trust, signatureRequired: false } }, { trustVerified: true }), /must require signature verification/);

const prepared = prepareManagedPrefix(baseManifest, { trustVerified: true, prefixRoot });
assert.equal(prepared.prefix, fs.realpathSync(managedPrefixPath(baseManifest.id, { prefixRoot })));
assert.equal(prepared.metadata.provider, 'swir.compat.wine');
const winDir = path.dirname(baseManifest.package.nativeEntryPoint);
fs.mkdirSync(winDir, { recursive: true });
fs.writeFileSync(baseManifest.package.nativeEntryPoint, 'MZ-self-test');

const safeEnv = sanitizeCompatibilityEnvironment({ PATH: '/usr/bin', LANG: 'pl_PL.UTF-8', LD_PRELOAD: '/tmp/evil.so', NODE_OPTIONS: '--require evil' });
assert.equal(safeEnv.PATH, '/usr/bin');
assert.equal(safeEnv.LANG, 'pl_PL.UTF-8');
assert.equal('LD_PRELOAD' in safeEnv, false);
assert.equal('NODE_OPTIONS' in safeEnv, false);

const plan = buildCompatibilityLaunchPlan(baseManifest, {
  trustVerified: true,
  prefixRoot,
  runtimePaths: { 'swir.compat.wine': fakeRuntime },
  runtimeRoots: [runtimeRoot],
  args: ['--safe', ';touch /tmp/should-not-exist'],
  environment: { PATH: '/usr/bin', LANG: 'en_US.UTF-8', WINEPREFIX: '/tmp/attacker', LD_PRELOAD: '/tmp/evil.so' }
});
assert.equal(plan.schema, 'swir.windows-compat-launch/0.1');
assert.equal(plan.mode, 'guarded');
assert.equal(plan.brokerRequired, true);
assert.equal(plan.shell, false);
assert.equal(plan.runtime.family, 'wine');
assert.equal(plan.runtime.executable, fs.realpathSync(fakeRuntime));
assert.deepEqual(plan.runtime.args.slice(-2), ['--safe', ';touch /tmp/should-not-exist']);
assert.equal(plan.environment.WINEPREFIX, prepared.prefix);
assert.equal(plan.environment.WINEARCH, 'win64');
assert.equal('LD_PRELOAD' in plan.environment, false);

const outside = path.join(temp, 'outside.exe');
fs.writeFileSync(outside, 'MZ');
assert.throws(() => buildCompatibilityLaunchPlan({ ...baseManifest, package: { ...baseManifest.package, nativeEntryPoint: outside } }, {
  trustVerified: true, prefixRoot, runtimePaths: { 'swir.compat.wine': fakeRuntime }, runtimeRoots: [runtimeRoot]
}), /outside its managed prefix/);

const driverLike = path.join(prepared.prefix, 'drive_c', 'driver.sys');
fs.writeFileSync(driverLike, 'SYS');
assert.throws(() => buildCompatibilityLaunchPlan({ ...baseManifest, package: { ...baseManifest.package, nativeEntryPoint: driverLike } }, {
  trustVerified: true, prefixRoot, runtimePaths: { 'swir.compat.wine': fakeRuntime }, runtimeRoots: [runtimeRoot]
}), /FORBIDDEN_WINDOWS_ARTIFACT/);

assert.throws(() => buildCompatibilityLaunchPlan(baseManifest, {
  trustVerified: true, prefixRoot, runtimePaths: { 'swir.compat.wine': fakeRuntime }, runtimeRoots: [path.join(temp, 'other-root')]
}), /outside approved roots/);

const protonManifest = {
  ...baseManifest,
  id: 'swir.selftest.proton-app',
  provider: 'swir.compat.proton',
  package: { ...baseManifest.package, nativeEntryPoint: path.join(prefixRoot, 'swir.selftest.proton-app', 'drive_c', 'game.exe') }
};
prepareManagedPrefix(protonManifest, { trustVerified: true, prefixRoot });
fs.mkdirSync(path.dirname(protonManifest.package.nativeEntryPoint), { recursive: true });
fs.writeFileSync(protonManifest.package.nativeEntryPoint, 'MZ-game');
const protonPlan = buildCompatibilityLaunchPlan(protonManifest, {
  trustVerified: true,
  prefixRoot,
  runtimePaths: { 'swir.compat.proton': fakeRuntime },
  runtimeRoots: [runtimeRoot]
});
assert.equal(protonPlan.runtime.family, 'proton');
assert.equal(protonPlan.runtime.args[0], 'run');
assert.equal(protonPlan.environment.STEAM_COMPAT_DATA_PATH, fs.realpathSync(managedPrefixPath(protonManifest.id, { prefixRoot })));

let captured = null;
class FakeChild extends EventEmitter {
  constructor() { super(); this.pid = 4242; }
  kill(signal) { this.killedWith = signal; return true; }
}
const fakeChild = new FakeChild();
const service = new WindowsCompatibilityService({
  prefixRoot,
  runtimePaths: { 'swir.compat.wine': fakeRuntime },
  runtimeRoots: [runtimeRoot],
  spawnImpl(executable, args, options) {
    captured = { executable, args, options };
    return fakeChild;
  }
});
const started = service.launch(baseManifest, { trustVerified: true, args: ['--hello', 'A&B'], environment: { PATH: '/usr/bin', LD_PRELOAD: '/tmp/nope' } });
assert.equal(started.state, 'running');
assert.equal(started.pid, 4242);
assert.equal(captured.options.shell, false);
assert.deepEqual(captured.args.slice(-2), ['--hello', 'A&B']);
assert.equal('LD_PRELOAD' in captured.options.env, false);
assert.throws(() => service.launch(baseManifest, { trustVerified: true }), /already running/);
assert.equal(service.stop(baseManifest.id, { signal: 'SIGTERM' }), true);
assert.throws(() => service.stop(baseManifest.id, { signal: 'SIGHUP' }), /unsupported stop signal/);
fakeChild.emit('exit', 0, null);
assert.equal(service.get(baseManifest.id).state, 'exited');
assert.equal(service.forget(baseManifest.id), true);

fs.rmSync(temp, { recursive: true, force: true });
console.log('SWIR Windows compatibility service self-tests: OK');
