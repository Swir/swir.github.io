import assert from 'node:assert/strict';
import { DistributionRepositoryTrustVerifier, RepositoryTrustError, loadRepositoryTrustPolicy, validateRepositoryTrustPolicy } from './distribution-repository-trust.mjs';

const policy = {
  schema: 'swir.system-repository-trust-policy/0.1',
  defaultRepositoryId: 'debian-main',
  repositories: [{
    id: 'debian-main',
    manager: 'apt',
    nativeId: 'deb.debian.org/debian',
    sourceClass: 'distribution-repository',
    distributions: ['debian'],
    signatureVerification: 'native-required',
    allowInsecure: false,
    enabled: true
  }]
};
validateRepositoryTrustPolicy(policy);
const loadedPolicy = loadRepositoryTrustPolicy('/etc/swir/repository-trust-policy.json', {
  fileProbe: () => ({ isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100644, size: 1024 }),
  readFile: () => JSON.stringify(policy)
});
assert.equal(loadedPolicy.defaultRepositoryId, 'debian-main');
assert.throws(
  () => loadRepositoryTrustPolicy('/etc/swir/repository-trust-policy.json', {
    fileProbe: () => ({ isFile: true, isSymbolicLink: false, uid: 1000, mode: 0o100644, size: 1024 }),
    readFile: () => JSON.stringify(policy)
  }),
  error => error instanceof RepositoryTrustError && error.code === 'UNSAFE_REPOSITORY_POLICY_OWNER'
);

const calls = [];
const verifier = new DistributionRepositoryTrustVerifier({
  policy,
  fileProbe: () => ({ isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100755 }),
  runner: async (command, args, options) => {
    calls.push({ command, args, options });
    return {
      exitCode: 0,
      signal: null,
      stdout: 'demo:\n  Installed: (none)\n  Candidate: 1.2.3\n  Version table:\n     1.2.3 500\n        500 http://deb.debian.org/debian stable/main amd64 Packages\n',
      stderr: ''
    };
  },
  clock: () => '2026-09-16T21:10:00.000Z',
  proofIdFactory: () => 'proof:repo:0001'
});

const proof = await verifier.verifyRepository({
  repositoryId: null,
  manager: 'apt',
  distribution: { id: 'debian', family: 'debian' },
  packageName: 'demo',
  operation: 'install',
  signatureRequired: true
});
assert.equal(proof.verified, true);
assert.equal(proof.repositoryId, 'debian-main');
assert.equal(proof.nativeRepositoryId, 'deb.debian.org/debian');
assert.equal(proof.evidence, 'native-read-only-probe');
assert.equal(calls[0].command, '/usr/bin/apt-cache');
assert.deepEqual(calls[0].args, ['policy', 'demo']);
assert.deepEqual(calls[0].options.env, { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });

const remove = await verifier.verifyRepository({
  repositoryId: 'debian-main',
  manager: 'apt',
  distribution: { id: 'debian' },
  packageName: 'demo',
  operation: 'remove',
  signatureRequired: true
});
assert.equal(remove.evidence, 'policy-only-remove');
assert.equal(calls.length, 1, 'remove should not need remote availability proof');

const missingPackage = new DistributionRepositoryTrustVerifier({
  policy,
  fileProbe: () => ({ isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100755 }),
  runner: () => ({ exitCode: 0, signal: null, stdout: 'demo:\n Candidate: (none)\n', stderr: '' })
});
await assert.rejects(
  () => missingPackage.verifyRepository({ repositoryId: 'debian-main', manager: 'apt', distribution: { id: 'debian' }, packageName: 'demo', operation: 'install', signatureRequired: true }),
  error => error instanceof RepositoryTrustError && error.code === 'PACKAGE_NOT_PROVEN_IN_TRUSTED_REPOSITORY'
);

await assert.rejects(
  () => verifier.verifyRepository({ repositoryId: 'debian-main', manager: 'apt', distribution: { id: 'ubuntu' }, packageName: 'demo', operation: 'install', signatureRequired: true }),
  error => error instanceof RepositoryTrustError && error.code === 'REPOSITORY_DISTRIBUTION_MISMATCH'
);

assert.throws(
  () => validateRepositoryTrustPolicy({ ...policy, repositories: [{ ...policy.repositories[0], allowInsecure: true }] }),
  error => error instanceof RepositoryTrustError && error.code === 'INSECURE_REPOSITORY_POLICY'
);

const badBinary = new DistributionRepositoryTrustVerifier({
  policy,
  fileProbe: () => ({ isFile: true, isSymbolicLink: false, uid: 1000, mode: 0o100755 }),
  runner: () => { throw new Error('must not execute'); }
});
await assert.rejects(
  () => badBinary.verifyRepository({ repositoryId: 'debian-main', manager: 'apt', distribution: { id: 'debian' }, packageName: 'demo', operation: 'install', signatureRequired: true }),
  error => error instanceof RepositoryTrustError && error.code === 'UNTRUSTED_PACKAGE_MANAGER_OWNER'
);

console.log('SWIR distribution repository trust self-test OK');
