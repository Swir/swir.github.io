import { loadRepositoryTrustPolicy, validateRepositoryTrustPolicy, DistributionRepositoryTrustVerifier } from './distribution-repository-trust.mjs';
import { PeerAuthorizationGrantVerifier, PeerPackageAuthorizationBroker } from '../ipc/peer-authorization-grant.mjs';

function assert(condition, message) { if (!condition) throw new Error(message); }
export class PeerAuthorizedSystemPackageSecurityBoundary {
  constructor({ repositoryPolicy, authorizationBroker, trustVerifier } = {}) {
    this.repositoryPolicy = validateRepositoryTrustPolicy(repositoryPolicy);
    assert(authorizationBroker && typeof authorizationBroker.authorize === 'function', 'authorizationBroker.authorize is required');
    assert(trustVerifier && typeof trustVerifier.verifyRepository === 'function', 'trustVerifier.verifyRepository is required');
    this.authorizationBroker = authorizationBroker; this.trustVerifier = trustVerifier;
    this.allowlistedRepositories = Object.freeze(this.repositoryPolicy.repositories.filter(entry => entry.enabled === true).map(entry => entry.id)); Object.freeze(this);
  }
  describe() { return { schema: 'swir.system-package-security-boundary/0.1', authorization: 'polkit-peer-so-peercred-short-lived-hmac-grant', peerIdentity: 'kernel-so-peercred-plus-active-local-logind-session', trust: 'root-owned-policy-plus-native-read-only-probe', allowlistedRepositories: [...this.allowlistedRepositories], arbitraryRepositoryUrls: false, callerSuppliedUnixIdentity: false, grantReplayAllowed: false, inheritedEnvironment: false, shellExecution: false }; }
}
export function createPeerAuthorizedSystemPackageSecurityBoundary({ repositoryPolicyPath = '/etc/swir/repository-trust-policy.json', repositoryPolicy, policyLoadOptions, peerGrantOptions, trustOptions } = {}) {
  const policy = repositoryPolicy || loadRepositoryTrustPolicy(repositoryPolicyPath, policyLoadOptions);
  const verifier = new PeerAuthorizationGrantVerifier(peerGrantOptions); const authorizationBroker = new PeerPackageAuthorizationBroker({ verifier });
  const trustVerifier = new DistributionRepositoryTrustVerifier({ policy, ...(trustOptions || {}) });
  return new PeerAuthorizedSystemPackageSecurityBoundary({ repositoryPolicy: policy, authorizationBroker, trustVerifier });
}
