# SWIR System Package Transactions 0.1

Status: **implemented foundation / host integration pending**

This document defines the first executable transaction boundary between the read-only `swir.package.system` distribution provider and future SWIR OS System Edition package management. It does **not** mark the System Edition package-manager roadmap items complete yet: the service is implemented and contract-tested, but still needs real base-distribution integration, production authorization/trust/snapshot adapters, and hardware/VM end-to-end validation.

## Goals

System package mutation must never be a Store UI action that directly launches a package manager. The mutation path is split into explicit layers:

```text
SWIR Store / Update Center
        |
        v
DistributionPackageProvider
(read-only verified plan)
        |
        v
SystemPackageTransactionService
  | trust verification
  | authorization binding
  | pre-mutation snapshot
  | durable journal
  | exact command re-validation
        |
        v
GuardedPkexecPackageExecutor
  | root-owned executable checks
  | fixed executable allowlist
  | fixed environment
  | shell = false
        |
        v
apt / dnf / rpm-ostree / pacman / zypper
```

## Implemented transaction phases

`SystemPackageTransactionService` accepts only `swir.system-package-plan/0.1` plans from `swir.package.system`. Before a privileged handoff it requires all of the following:

1. Linux-native execution class and an explicitly supported package manager.
2. Exact recomputation of the package-manager command from manager, operation and validated package name. A plan containing a different executable or argument vector is rejected.
3. Distribution repository source class with arbitrary repository URLs disabled.
4. Repository ID allowlisting when a repository ID is present.
5. Repository signature verification through an injected trust verifier.
6. An authorization broker grant bound to `packages.mutate`, the package ID, operation and SHA-256 digest of the immutable plan.
7. A pre-mutation snapshot from the selected System snapshot provider.
8. A durable owner-only journal written and fsynced before privileged execution.

The journal then records state transitions:

```text
prepared -> mutating -> verifying -> committed
                     \
                      -> rolling-back -> rolled-back
                     \
                      -> failed-needs-recovery
```

The original plan is stored with a canonical SHA-256 digest. Recovery refuses to execute a journal whose stored plan no longer matches that digest.

## Privileged execution boundary

`GuardedPkexecPackageExecutor` is the first Linux privilege transport adapter. It uses `/usr/bin/pkexec` and never invokes a shell. The adapter independently validates the command shape even though the transaction service already validated it. This is intentional defense in depth.

Default logical executable mapping:

| Manager | Executable |
|---|---|
| apt | `/usr/bin/apt-get` |
| dnf | `/usr/bin/dnf` |
| rpm-ostree | `/usr/bin/rpm-ostree` |
| pacman | `/usr/bin/pacman` |
| zypper | `/usr/bin/zypper` |

Before execution, both `pkexec` and the selected package-manager executable must resolve to regular, root-owned files that are not group/world writable. The subprocess receives a fixed `PATH`, `LANG` and `LC_ALL`; the calling process environment is not inherited. Output and execution time are bounded.

The executor is a transport primitive, not the policy authority. Production System Edition still needs a dedicated polkit policy/agent integration so authorization is tied to the active SWIR session and package transaction identity.

## Rollback and crash recovery

Automatic rollback is deliberately conservative in 0.1. Only `rpm-ostree` plans declaring `deployment-rollback` may use automatic rollback, because SWIR can derive a fixed trusted rollback command (`rpm-ostree rollback`) without accepting arbitrary journal-provided commands.

For apt, dnf, pacman and zypper, a failed mutation is recorded as `failed-needs-recovery` until a version-aware snapshot/rollback provider is implemented and validated for the selected base distribution. The service does not pretend that reinstalling an old package version is always possible.

At startup, `recoverPending()` scans only bounded regular journal files. A pending rpm-ostree transaction requires a new `packages.recover` authorization grant before rollback. Corrupt or digest-mismatched journals are reported and never executed.

## Contracts and tests

Implemented files:

```text
system/packages/package-transaction-service.mjs
system/packages/package-transaction-service.selftest.mjs
system/packages/privileged-package-executor.mjs
system/packages/privileged-package-executor.selftest.mjs
system/packages/validate-package-transaction-service.mjs
system/contracts/package-transaction-journal.schema.json
.github/workflows/system-package-transaction-contract.yml
```

The self-tests cover successful commit, trust rejection, authorization rejection, command tampering, repository allowlisting, durable journal state, failed health verification, rpm-ostree rollback, restart recovery, corrupted-journal blocking, `shell=false`, environment isolation, root ownership checks and non-zero package-manager exit handling. Tests inject the process runner and never modify the GitHub Actions host.

## Next production gates

Before the roadmap items **dependency-aware system package manager/updater** and **journaled driver/firmware/package transactions** can be checked complete, System Edition still needs:

- a production repository trust verifier backed by the selected distribution's package trust database;
- an active-session authorization broker and explicit polkit policy;
- package/version snapshot adapters for the chosen base distribution;
- version-aware rollback for non-atomic package managers, or a filesystem/image snapshot strategy;
- package health probes tied to manifests and native entry points;
- integration with SWIR Update Center and Driver Center;
- VM tests that perform real install/update/remove/recovery against a disposable System Edition image;
- reboot/interruption tests proving recovery after power-loss-style termination.

Until those gates pass, this 0.1 implementation remains a guarded foundation rather than a declaration that the bootable System Edition package stack is complete.
