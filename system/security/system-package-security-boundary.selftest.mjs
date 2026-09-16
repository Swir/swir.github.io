import assert from 'node:assert/strict';
import { createSystemPackageSecurityBoundary } from './system-package-security-boundary.mjs';

const policy = {
  schema: 'swir.system-repository-trust-policy/0.1',
  defaultRepositoryId: 'base-main',
  repositories: [{
    id: 'base-main',
    manager: 'apt',
    nativeId: 'mirror.example.invalid/base',
    sourceClass: 'distribution-repository',
    distributions: ['debian'],
    signatureVerification: 'native-required',
    allowInsecure: false,
    enabled: true
  }]
};

const boundary = createSystemPackageSecurityBoundary({
  repositoryPolicy: policy,
  polkitOptions: {
    processProbe: () => ({ pid: 42, uid: 1000, startTime: '777' }),
    fileProbe: () => ({ isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100755 }),
    runner: () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
    grantIdFactory: () => 'grant:boundary:001'
  },
  trustOptions: {
    fileProbe: () => ({ isFile: true, isSymbolicLink: false, uid: 0, mode: 0o100755 }),
    runner: () => ({ exitCode: 0, signal: null, stdout: 'demo:\n Candidate: 1.0\n 500 http://mirror.example.invalid/base stable/main amd64 Packages\n', stderr: '' }),
    proofIdFactory: () => 'proof:boundary:001'
  }
});

assert.deepEqual(boundary.allowlistedRepositories, ['base-main']);
assert.equal(boundary.describe().shellExecution, false);

const auth = await boundary.authorizationBroker.authorize({
  schema: 'swir.system-authorization-request/0.1',
  scope: 'packages.mutate',
  planDigest: 'b'.repeat(64),
  packageId: 'swir.demo',
  operation: 'install',
  context: { actorId: 'uid:1000' }
});
assert.equal(auth.authorized, true);

const trust = await boundary.trustVerifier.verifyRepository({
  repositoryId: 'base-main',
  manager: 'apt',
  distribution: { id: 'debian' },
  packageName: 'demo',
  operation: 'install',
  signatureRequired: true
});
assert.equal(trust.verified, true);
assert.equal(trust.repositoryId, 'base-main');
console.log('SWIR System package security boundary self-test OK');
