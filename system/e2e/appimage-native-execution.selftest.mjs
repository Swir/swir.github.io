import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppImageUserPackageAdapter } from '../packages/appimage-user-package-provider.mjs';
import { NativePackageExecutionService } from '../runtime/native-package-execution-service.mjs';

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'swir-appimage-e2e-'));
const installRoot = path.join(root, 'apps');
const artifact = path.join(root, 'hello.AppImage');
const marker = path.join(root, 'launched.txt');
const target = path.join(installRoot, 'org.swir.hello.AppImage');
await fs.promises.writeFile(artifact, `#!/bin/sh\nprintf 'SWIR_NATIVE_OK' > "${marker}"\n`);
const sha256 = crypto.createHash('sha256').update(await fs.promises.readFile(artifact)).digest('hex');
const manifest = {
  schema: 'swir.package-provider/0.2',
  id: 'org.swir.hello',
  targetEditions: ['system'],
  executionClass: 'linux-native',
  provider: 'swir.package.appimage',
  package: { name: 'SWIR Hello', sourceRef: 'hello.AppImage', nativeEntryPoint: target, scope: 'user', sha256 },
  trust: { sourceClass: 'swir-signed', repositoryId: 'swir-appimage-catalog', signatureRequired: true }
};

const adapter = new AppImageUserPackageAdapter({ installRoot });
await adapter.execute('install', manifest, { artifactPath: artifact, signatureVerified: true });
const service = new NativePackageExecutionService();
const exited = new Promise((resolve, reject) => {
  service.once('exited', resolve);
  service.once('processError', ({ error }) => reject(error));
});
const launched = service.launch(manifest, { trustVerified: true, allowedRoots: [installRoot], stdio: 'ignore' });
assert.equal(launched.state, 'running');
const result = await exited;
assert.equal(result.exitCode, 0);
assert.equal(await fs.promises.readFile(marker, 'utf8'), 'SWIR_NATIVE_OK');
await fs.promises.rm(root, { recursive: true, force: true });
console.log('AppImage -> native execution integration self-test: OK');
