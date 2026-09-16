import { DistributionPackageProvider } from './distribution-package-provider.mjs';
import { SystemPackageTransactionService } from './package-transaction-service.mjs';
import { GuardedPkexecPackageExecutor } from './privileged-package-executor.mjs';
import { DistributionPackageSnapshotProvider, NativePackageHealthVerifier } from './distribution-package-state.mjs';
import { createSystemPackageSecurityBoundary } from '../security/system-package-security-boundary.mjs';

const OPERATIONS = new Set(['install', 'update', 'remove']);

function assert(condition, code, message) {
  if (condition) return;
  const error = new Error(message);
  error.name = 'SystemPackageStackError';
  error.code = code;
  throw error;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function validateHost(host) {
  assert(host && typeof host === 'object' && !Array.isArray(host), 'INVALID_HOST', 'System package stack requires a trusted host snapshot');
  assert(host.distribution && typeof host.distribution.id === 'string' && host.distribution.id.length > 0, 'INVALID_HOST_DISTRIBUTION', 'host distribution id is required');
  assert(host.capabilities && Array.isArray(host.capabilities.packageManagers), 'INVALID_HOST_CAPABILITIES', 'host package-manager capability list is required');
  return clone(host);
}

export class SystemPackageStack {
  #provider;
  #transactions;
  #security;

  constructor({ provider, transactionService, securityBoundary } = {}) {
    assert(provider && typeof provider.planInstall === 'function' && typeof provider.planUpdate === 'function' && typeof provider.planRemove === 'function', 'INVALID_PROVIDER', 'DistributionPackageProvider-compatible provider is required');
    assert(transactionService && typeof transactionService.execute === 'function' && typeof transactionService.recoverPending === 'function', 'INVALID_TRANSACTION_SERVICE', 'SystemPackageTransactionService-compatible service is required');
    assert(securityBoundary && Array.isArray(securityBoundary.allowlistedRepositories), 'INVALID_SECURITY_BOUNDARY', 'System package security boundary is required');
    this.#provider = provider;
    this.#transactions = transactionService;
    this.#security = securityBoundary;
    Object.freeze(this);
  }

  describe() {
    return Object.freeze({
      schema: 'swir.system-package-stack/0.1',
      provider: clone(this.#provider.probe?.() || null),
      security: clone(this.#security.describe?.() || null),
      allowlistedRepositories: [...this.#security.allowlistedRepositories],
      directCallerPlanExecution: false,
      arbitraryHostOverride: false,
      arbitraryRepositoryUrlAllowed: false,
      privilegedMutationPath: 'provider-plan -> trust -> polkit -> snapshot -> journal -> guarded-pkexec -> health'
    });
  }

  plan(operation, manifest) {
    assert(OPERATIONS.has(operation), 'UNSUPPORTED_OPERATION', 'System package operation is unsupported');
    if (operation === 'install') return this.#provider.planInstall(clone(manifest));
    if (operation === 'update') return this.#provider.planUpdate(clone(manifest));
    return this.#provider.planRemove(clone(manifest));
  }

  async execute(operation, manifest, authorizationContext = {}) {
    assert(authorizationContext && typeof authorizationContext === 'object' && !Array.isArray(authorizationContext), 'INVALID_AUTHORIZATION_CONTEXT', 'authorization context must be an object');
    const plan = this.plan(operation, manifest);
    return this.#transactions.execute(plan, clone(authorizationContext));
  }

  recoverPending(authorizationContext = {}) {
    assert(authorizationContext && typeof authorizationContext === 'object' && !Array.isArray(authorizationContext), 'INVALID_AUTHORIZATION_CONTEXT', 'authorization context must be an object');
    return this.#transactions.recoverPending(clone(authorizationContext));
  }
}

export function createSystemPackageStack({
  host,
  journalDirectory = '/var/lib/swir/package-transactions',
  repositoryPolicyPath = '/etc/swir/repository-trust-policy.json'
} = {}) {
  const trustedHost = validateHost(host);
  assert(typeof journalDirectory === 'string' && journalDirectory.startsWith('/'), 'INVALID_JOURNAL_DIRECTORY', 'System package journalDirectory must be absolute');
  assert(typeof repositoryPolicyPath === 'string' && repositoryPolicyPath.startsWith('/'), 'INVALID_REPOSITORY_POLICY_PATH', 'repositoryPolicyPath must be absolute');

  // Production assembly deliberately exposes no runner/executor/auth dependency injection.
  // Tests may instantiate SystemPackageStack directly with controlled compatible doubles.
  const security = createSystemPackageSecurityBoundary({ repositoryPolicyPath });
  const provider = new DistributionPackageProvider({
    host: trustedHost,
    allowlistedRepositories: security.allowlistedRepositories
  });
  const transactionService = new SystemPackageTransactionService({
    journalDirectory,
    executor: new GuardedPkexecPackageExecutor(),
    authorizationBroker: security.authorizationBroker,
    trustVerifier: security.trustVerifier,
    snapshotProvider: new DistributionPackageSnapshotProvider(),
    healthVerifier: new NativePackageHealthVerifier(),
    allowlistedRepositories: security.allowlistedRepositories
  });
  return new SystemPackageStack({ provider, transactionService, securityBoundary: security });
}

export const SystemPackageStackPolicy = Object.freeze({
  schema: 'swir.system-package-stack/0.1',
  productionDependencyInjection: false,
  directCallerPlanExecution: false,
  arbitraryHostOverride: false,
  arbitraryRepositoryUrls: false,
  rootOwnedRepositoryPolicy: true,
  authorization: 'polkit-current-process-subject',
  executor: 'guarded-pkexec',
  durableJournalBeforeMutation: true,
  postMutationHealthVerification: true
});
