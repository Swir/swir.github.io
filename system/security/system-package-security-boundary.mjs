import { PolkitSystemAuthorizationBroker } from './polkit-authorization-broker.mjs';
import { DistributionRepositoryTrustVerifier, loadRepositoryTrustPolicy, validateRepositoryTrustPolicy } from './distribution-repository-trust.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export class SystemPackageSecurityBoundary {
  constructor({ repositoryPolicy, authorizationBroker, trustVerifier } = {}) {
    this.repositoryPolicy = validateRepositoryTrustPolicy(repositoryPolicy);
    assert(authorizationBroker && typeof authorizationBroker.authorize === 'function', 'authorizationBroker.authorize is required');
    assert(trustVerifier && typeof trustVerifier.verifyRepository === 'function', 'trustVerifier.verifyRepository is required');
    this.authorizationBroker = authorizationBroker;
    this.trustVerifier = trustVerifier;
    this.allowlistedRepositories = Object.freeze(this.repositoryPolicy.repositories.filter(entry => entry.enabled === true).map(entry => entry.id));
    Object.freeze(this);
  }

  describe() {
    return {
      schema: 'swir.system-package-security-boundary/0.1',
      authorization: 'polkit-current-process-subject',
      trust: 'root-owned-policy-plus-native-read-only-probe',
      allowlistedRepositories: [...this.allowlistedRepositories],
      arbitraryRepositoryUrls: false,
      inheritedEnvironment: false,
      shellExecution: false
    };
  }
}

export function createSystemPackageSecurityBoundary({
  repositoryPolicyPath = '/etc/swir/repository-trust-policy.json',
  repositoryPolicy,
  policyLoadOptions,
  polkitOptions,
  trustOptions
} = {}) {
  const policy = repositoryPolicy || loadRepositoryTrustPolicy(repositoryPolicyPath, policyLoadOptions);
  const authorizationBroker = new PolkitSystemAuthorizationBroker(polkitOptions);
  const trustVerifier = new DistributionRepositoryTrustVerifier({ policy, ...(trustOptions || {}) });
  return new SystemPackageSecurityBoundary({ repositoryPolicy: policy, authorizationBroker, trustVerifier });
}
