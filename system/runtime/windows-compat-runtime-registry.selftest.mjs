import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WindowsCompatibilityRuntimeRegistry,
  WindowsCompatibilityRuntimeRegistryPolicy
} from './windows-compat-runtime-registry.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swir-compat-runtime-'));
try {
  const bin = path.join(root, 'bin');
  const protonDir = path.join(root, 'proton', 'Proton-9.0');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(protonDir, { recursive: true });

  const wine = path.join(bin, 'wine64');
  const proton = path.join(protonDir, 'proton');
  fs.writeFileSync(wine, '#!/bin/sh\nprintf "wine-9.0\\n"\n', { mode: 0o755 });
  fs.writeFileSync(proton, '#!/bin/sh\nprintf "Proton 9.0 test\\n"\n', { mode: 0o755 });

  const rejected = path.join(bin, 'wine');
  fs.writeFileSync(rejected, '#!/bin/sh\nprintf "unsafe-wine\\n"\n', { mode: 0o777 });

  const registry = new WindowsCompatibilityRuntimeRegistry({
    runtimeRoots: [root],
    requireRootOwned: false,
    probeTimeoutMs: 1500
  });
  const inventory = registry.discover();
  assert.equal(inventory.schema, 'swir.compat-runtime-inventory/0.1');
  assert.equal(inventory.mode, 'read-only-discovery');
  assert.equal(inventory.arbitraryDownloadAllowed, false);
  assert.equal(inventory.shellExecution, false);
  assert.equal(inventory.runtimes.length, 2);
  assert.ok(inventory.rejected.some(item => item.candidate === rejected && item.code === 'RUNTIME_WRITABLE_BY_UNTRUSTED'));

  const selectedWine = registry.select('swir.compat.wine');
  assert.equal(selectedWine.executable, fs.realpathSync(wine));
  assert.equal(selectedWine.healthy, true);
  assert.match(selectedWine.version, /wine-9\.0/);
  assert.match(selectedWine.id, /^compat:wine:[a-f0-9]{16}$/);

  const selectedProton = registry.select('swir.compat.proton');
  assert.equal(selectedProton.executable, fs.realpathSync(proton));
  assert.match(selectedProton.version, /Proton 9\.0 test/);

  const serviceOptions = registry.serviceOptions();
  assert.equal(serviceOptions.runtimePaths['swir.compat.wine'], fs.realpathSync(wine));
  assert.equal(serviceOptions.runtimePaths['swir.compat.proton'], fs.realpathSync(proton));
  assert.deepEqual(serviceOptions.runtimeRoots, [path.resolve(root)]);

  assert.equal(registry.select('swir.compat.wine', { runtimeId: selectedWine.id }).id, selectedWine.id);
  assert.throws(() => registry.select('swir.compat.wine', { runtimeId: 'compat:wine:0000000000000000' }), error => error?.code === 'RUNTIME_ID_UNAVAILABLE');
  assert.throws(() => registry.select('swir.compat.unknown'), error => error?.code === 'UNSUPPORTED_PROVIDER');
  assert.throws(() => new WindowsCompatibilityRuntimeRegistry({ runtimeRoots: ['relative/path'] }), error => error?.code === 'INVALID_RUNTIME_ROOT');

  const rootRequired = new WindowsCompatibilityRuntimeRegistry({ runtimeRoots: [root], requireRootOwned: true });
  const rootInventory = rootRequired.discover();
  if (process.getuid?.() !== 0) {
    assert.equal(rootInventory.runtimes.length, 0);
    assert.ok(rootInventory.rejected.some(item => item.code === 'RUNTIME_NOT_ROOT_OWNED'));
  }

  assert.equal(WindowsCompatibilityRuntimeRegistryPolicy.rootOwnershipRequiredByDefault, true);
  assert.equal(WindowsCompatibilityRuntimeRegistryPolicy.groupWorldWritableRejected, true);
  assert.equal(WindowsCompatibilityRuntimeRegistryPolicy.arbitraryDownloads, false);
  console.log('Windows compatibility runtime registry self-test: OK');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
