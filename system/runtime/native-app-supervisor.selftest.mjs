import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { NativeAppSupervisor, NativeSupervisorPolicy } from './native-app-supervisor.mjs';

assert.equal(NativeSupervisorPolicy.oneProcessPerAppId, true);
assert.equal(NativeSupervisorPolicy.shellExecution, false);
assert.deepEqual(NativeSupervisorPolicy.allowedStopSignals, ['SIGTERM', 'SIGINT']);

const supervisor = new NativeAppSupervisor();
const truePath = fs.existsSync('/usr/bin/true') ? '/usr/bin/true' : null;
if (truePath) {
  const exited = once(supervisor, 'exited');
  const started = supervisor.launch({ schema: 'swir.native-launch/0.1', executionClass: 'linux-native', appId: 'swir.selftest.supervisor', executable: truePath, args: [] }, { environment: { PATH: '/usr/bin', HOME: '/tmp' } });
  assert.equal(started.state, 'running');
  assert(Number.isInteger(started.pid));
  assert.equal(supervisor.list({ includeExited: false }).length, 1);
  assert.throws(() => supervisor.launch({ schema: 'swir.native-launch/0.1', executionClass: 'linux-native', appId: 'swir.selftest.supervisor', executable: truePath, args: [] }), /already running/);
  const [finished] = await exited;
  assert.equal(finished.state, 'exited');
  assert.equal(finished.exitCode, 0);
  assert.equal(supervisor.get('swir.selftest.supervisor').state, 'exited');
  assert.equal(supervisor.stop('swir.selftest.supervisor'), false);
  assert.equal(supervisor.forget('swir.selftest.supervisor'), true);
  assert.equal(supervisor.get('swir.selftest.supervisor'), null);
}

assert.throws(() => supervisor.stop('bad id!'), /invalid appId/);
console.log('SWIR native application supervisor self-tests: OK');
