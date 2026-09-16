# SWIR System Package Stack 0.1

Status: **implemented integration foundation / real System image E2E pending**

`system/packages/system-package-stack.mjs` is the fail-closed production composition entry point for distribution packages. It creates the Distribution Package Provider, the root-owned repository/Polkit security boundary, the durable transaction service, the guarded `pkexec` executor, the package snapshot provider and the native health verifier.

The production factory accepts only a trusted host snapshot plus absolute journal and repository-policy paths. It deliberately does not accept caller-provided runners, executors or authorization brokers. Higher-level callers submit only a reviewed System package manifest and an `install`, `update` or `remove` operation; they cannot submit an arbitrary privileged command/plan or replace the captured host state through this API.

The resulting mutation path is:

```text
manifest + operation
  -> DistributionPackageProvider preview plan
  -> root-owned repository trust policy + native read-only repository probe
  -> Polkit authorization bound to current pid/start-time/uid + package/op/plan digest
  -> pre-mutation package snapshot
  -> durable transaction journal
  -> guarded pkexec package-manager execution
  -> native package health verification
  -> commit / verified rpm-ostree rollback / failed-needs-recovery
```

This module does not make the System Edition package-manager roadmap item complete by itself. Production completion still requires provisioning the real base-distribution repository policy and Polkit action into a disposable System image, then passing real install/update/remove/failure/recovery vectors there.

## Verification

`system/packages/system-package-stack.selftest.mjs` executes the complete composition with real provider/transaction/security classes and controlled native-process doubles. It verifies repository allowlisting, exact provider command generation, repository trust probing, Polkit action binding, journaled transaction execution, health verification, commit state and rejection of unsupported operations/untrusted repositories.

`system/packages/validate-system-package-stack.mjs` statically enforces the production composition boundary, including the absence of runner/executor/authorization dependency injection from `createSystemPackageStack()`.

`.github/workflows/system-package-stack-contract.yml` runs both checks and re-runs the transaction/provider/security boundary validators whenever the stack or its security-sensitive dependencies change.
