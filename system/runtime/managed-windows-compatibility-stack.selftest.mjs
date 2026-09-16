import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WindowsCompatibilityRuntimeRegistry } from './windows-compat-runtime-registry.mjs';
import {
  ManagedWindowsCompatibilityPolicy,
  ManagedWindowsCompatibilityStack
} from './managed-windows-compatibility-stack.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-managed-compat-'));
try {
  const runtimeRoot = path.join(root, 'runtime');
  const prefixRoot = path.join(root, 'prefixes');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const wine = path.join(runtimeRoot, 'wine64');
  fs.writeFileSync(wine, '#!/bin/sh\nprintf "wine-10.0-test\\n"\n', { mode: 0o755 });

  const registry = new WindowsCompatibilityRuntimeRegistry({
    runtimeRoots: [runtimeRoot],
    requireRootOwned: false,
    probeTimeoutMs: 1000
  });
  const stack = new ManagedWindowsCompatibilityStack({ registry, prefixRoot });
  const description = stack.describe();
  assert.equal(description.schema, 'swir.managed-windows-compatibility/0.1');
  assert.equal(description.runtimeCount, 1);
  assert.equal(description.healthyRuntimeCount, 1);
  assert.equal(description.providers.wine, true);
  assert.equal(description.providers.proton, false);
  assert.equal(description.arbitraryRuntimeDownloadAllowed, false);
  assert.equal(stack.inventory().runtimes[0].executable, fs.realpathSync(wine));
  assert.deepEqual(stack.list(), []);
  assert.equal(stack.get('missing'), null);
  assert.equal(stack.stop('missing'), false);
  assert.equal(stack.forget('missing'), false);

  assert.equal(ManagedWindowsCompatibilityPolicy.runtimeRootOwnershipRequired, true);
  assert.equal(ManagedWindowsCompatibilityPolicy.arbitraryRuntimeDownloadAllowed, false);
  assert.equal(ManagedWindowsCompatibilityPolicy.directWindowsKernelDriverSupport, false);
  console.log('Managed Windows compatibility stack self-test: OK');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
