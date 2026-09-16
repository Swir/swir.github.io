import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { launchNativeApp, sanitizeEnvironment, validateLaunchRequest, NativeLaunchPolicy } from './native-app-launcher.mjs';

assert.equal(NativeLaunchPolicy.shell, false);
assert.equal(NativeLaunchPolicy.executionClass, 'linux-native');
assert(!NativeLaunchPolicy.allowedRoots.includes('/tmp'));

const env = sanitizeEnvironment({ HOME: '/home/test', LANG: 'en_US.UTF-8', SECRET_TOKEN: 'must-not-pass', LD_PRELOAD: '/tmp/evil.so' });
assert.equal(env.HOME, '/home/test');
assert.equal(env.LANG, 'en_US.UTF-8');
assert.equal(env.SECRET_TOKEN, undefined);
assert.equal(env.LD_PRELOAD, undefined);

const truePath = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : null;
if (truePath) {
  const request = { schema: 'swir.native-launch/0.1', executionClass: 'linux-native', appId: 'swir.selftest.true', executable: truePath, args: [] };
  const checked = validateLaunchRequest(request);
  assert.equal(checked.executable, fs.realpathSync(truePath));
  const launched = launchNativeApp(request, { stdio: 'ignore', environment: { PATH: '/usr/bin', HOME: os.tmpdir(), LD_PRELOAD: '/tmp/blocked.so' } });
  const [code] = await once(launched.child, 'exit');
  assert.equal(code, 0);
}

assert.throws(() => validateLaunchRequest({ schema: 'swir.native-launch/0.1', executionClass: 'windows-compat', appId: 'bad', executable: '/usr/bin/true', args: [] }), /linux-native/);
assert.throws(() => validateLaunchRequest({ schema: 'swir.native-launch/0.1', executionClass: 'linux-native', appId: 'bad', executable: 'relative/app', args: [] }), /absolute/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-native-launch-'));
const fake = path.join(temp, 'fake-app');
fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
assert.throws(() => validateLaunchRequest({ schema: 'swir.native-launch/0.1', executionClass: 'linux-native', appId: 'swir.bad-root', executable: fake, args: [] }), /outside approved/);
fs.rmSync(temp, { recursive: true, force: true });

console.log('SWIR native Linux application launcher self-tests: OK');
