import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSystemImageProvisioningManifest, stageSystemImageFoundation, verifySystemImageFoundation, SystemImageProvisioningPolicy } from './system-image-provisioning.mjs';

const fsp = fs.promises;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'swir-image-provisioning-'));
const rootfs = path.join(temp, 'rootfs');
const inputs = path.join(temp, 'inputs');
await fsp.mkdir(rootfs, { recursive: true });
await fsp.mkdir(inputs, { recursive: true });

const policyPath = path.join(inputs, 'repository-trust-policy.json');
await fsp.writeFile(policyPath, JSON.stringify({
  schema: 'swir.system-repository-trust-policy/0.1',
  defaultRepositoryId: 'ubuntu-noble-main',
  repositories: [{
    id: 'ubuntu-noble-main',
    manager: 'apt',
    nativeId: 'ubuntu:noble:main',
    sourceClass: 'distribution-repository',
    distributions: ['ubuntu'],
    signatureVerification: 'native-required',
    allowInsecure: false,
    enabled: true
  }]
}, null, 2));

const manifest = await loadSystemImageProvisioningManifest();
assert.equal(manifest.schema, 'swir.system-image-provisioning-manifest/0.1');
assert.equal(manifest.policy.allowRealRootTarget, false);
assert.equal(manifest.policy.allowSymlinkDestinations, false);
assert.equal(manifest.policy.allowArbitraryUrls, false);
assert.equal(manifest.policy.allowExampleRepositoryPolicy, false);

const staged = await stageSystemImageFoundation({
  rootfs,
  sourceRoot: repoRoot,
  deploymentInputs: { repositoryTrustPolicy: policyPath },
  production: false,
  clock: () => '2026-09-17T03:00:00.000Z'
});
assert.equal(staged.schema, 'swir.system-image-provisioning-report/0.1');
assert.equal(staged.ready, true);
assert.equal(staged.staged, true);
assert.equal(staged.bootableImageClaim, false);
assert.equal(staged.blockers.length, 0);
assert.equal(staged.state.artifacts.length, 4);
assert.equal(staged.state.production, false);

const verified = await verifySystemImageFoundation({ rootfs, production: false });
assert.equal(verified.ready, true);
assert.equal(verified.blockers.length, 0);

const networkPolicy = path.join(rootfs, 'usr/share/polkit-1/actions/org.swir.system.network.policy');
await fsp.appendFile(networkPolicy, '\n<!-- tamper -->\n');
const tampered = await verifySystemImageFoundation({ rootfs, production: false });
assert.equal(tampered.ready, false);
assert(tampered.blockers.includes('file:polkit-network'));

const badRootfs = path.join(temp, 'symlink-rootfs');
await fsp.symlink(rootfs, badRootfs);
await assert.rejects(() => verifySystemImageFoundation({ rootfs: badRootfs, production: false }), error => error.code === 'ROOTFS_INVALID');
await assert.rejects(() => verifySystemImageFoundation({ rootfs: path.parse(rootfs).root, production: false }), error => error.code === 'REAL_ROOT_TARGET_FORBIDDEN');

const rootfs2 = path.join(temp, 'rootfs-example-policy');
await fsp.mkdir(rootfs2);
const examplePolicyPath = path.join(inputs, 'example-policy.json');
await fsp.writeFile(examplePolicyPath, JSON.stringify({
  schema: 'swir.system-repository-trust-policy/0.1',
  defaultRepositoryId: 'example-main',
  repositories: [{
    id: 'example-main', manager: 'apt', nativeId: 'deb.example.invalid/main', sourceClass: 'distribution-repository',
    distributions: ['debian'], signatureVerification: 'native-required', allowInsecure: false, enabled: true
  }]
}));
await assert.rejects(() => stageSystemImageFoundation({
  rootfs: rootfs2,
  sourceRoot: repoRoot,
  deploymentInputs: { repositoryTrustPolicy: examplePolicyPath },
  production: false
}), error => error.code === 'EXAMPLE_REPOSITORY_POLICY_FORBIDDEN');

assert.equal(SystemImageProvisioningPolicy.explicitRootfsRequired, true);
assert.equal(SystemImageProvisioningPolicy.liveRootTargetAllowed, false);
assert.equal(SystemImageProvisioningPolicy.symlinkDestinationsAllowed, false);
assert.equal(SystemImageProvisioningPolicy.exampleRepositoryPolicyAllowed, false);
assert.equal(SystemImageProvisioningPolicy.shellExecution, false);
assert.equal(SystemImageProvisioningPolicy.bootableImageClaim, false);

const rootfs3 = path.join(temp, 'rootfs-ancestor-symlink');
const outside = path.join(temp, 'outside');
await fsp.mkdir(path.join(rootfs3, 'var', 'lib'), { recursive: true });
await fsp.mkdir(outside, { recursive: true });
await fsp.symlink(outside, path.join(rootfs3, 'var', 'lib', 'swir'));
await assert.rejects(() => stageSystemImageFoundation({
  rootfs: rootfs3, sourceRoot: repoRoot, deploymentInputs: { repositoryTrustPolicy: policyPath }, production: false
}), error => error.code === 'IMAGE_PATH_SYMLINK_ANCESTOR');

await fsp.rm(temp, { recursive: true, force: true });
console.log('System image provisioning self-test: OK');
console.log(`Provisioned artifacts: ${staged.state.artifacts.length}; verification checks: ${verified.checks.length}`);
