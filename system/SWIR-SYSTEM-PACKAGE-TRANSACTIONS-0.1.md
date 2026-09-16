# SWIR System Package Transactions 0.1

Status: **implemented foundation / host integration pending**

This document defines the first executable transaction boundary between the read-only `swir.package.system` distribution provider and future SWIR OS System Edition package management. It does **not** mark the System Edition package-manager roadmap items complete yet: the service is implemented and contract-tested, including read-only package-state snapshots, native entry-point health probes and transaction-journal tamper resistance, but still needs real base-distribution integration, production authorization/trust policy and hardware/VM end-to-end validation.

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
7. A pre-mutation snapshot from the selected System snapshot provider, validated against the exact package ID, package manager and package name in the plan.
8. A durable owner-only journal written and fsynced before privileged execution.

The journal then records state transitions:

```text
prepared -> mutating -> verifying -> committed
                     \
                      -> rolling-back -> rolled-back
                     \
                      -> failed-needs-recovery
```

The original plan is stored with a canonical SHA-256 digest. Recovery refuses to execute a journal whose stored plan no longer matches that digest. The journal directory is required to be a real non-symlink directory that is not group/world writable, journal files are owner-only, and the stored transaction ID must match the journal filename. This prevents a copied or renamed transaction record from being treated as a different recovery transaction.

## Read-only package state and health adapters

`DistributionPackageSnapshotProvider` adds the first concrete host-state adapter used before mutation. It is deliberately read-only and does not elevate privileges:

| Package family | State query |
|---|---|
| apt/dpkg | `/usr/bin/dpkg-query` |
| dnf / rpm-ostree / zypper | `/usr/bin/rpm -q` |
| pacman | `/usr/bin/pacman -Q` |

The adapter returns `swir.package-snapshot/0.1` with installed/not-installed state, the currently installed version when available and the exact query source. Package names are validated before argument construction, the subprocess always uses `shell=false`, inherits no caller environment and has time/output limits. The transaction service independently checks that the snapshot source is correct for the selected package manager before the snapshot can become recovery evidence.

`NativePackageHealthVerifier` provides the first post-mutation health gate for Linux-native applications. Install/update plans must expose an absolute native entry point whose resolved target remains below an explicitly allowed System root (defaults: `/usr` and `/opt`), resolves to a regular file and is executable. Symlink escapes outside those roots are rejected. Remove operations have a separate health path and do not require an entry point that should no longer exist.

The transaction service binds every health result back to the exact package ID and package name from the authorized plan before it can commit a transaction. Recovery performs the same binding checks on persisted snapshot/health records before an automatic rollback is allowed.

The journal contract binds the embedded snapshot to `package-snapshot.schema.json` and any health result to `package-health.schema.json`, so those records have an explicit machine-readable shape instead of free-form objects.

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

At startup, `recoverPending()` scans only bounded regular journal files. Before recovery it verifies the journal ID/filename binding, original plan digest and package snapshot/health binding. A pending rpm-ostree transaction requires a new `packages.recover` authorization grant before rollback. Corrupt, writable, renamed or digest-mismatched journals are blocked and never executed.

## Contracts and tests

Implemented files:

```text
system/packages/package-transaction-service.mjs
system/packages/package-transaction-service.selftest.mjs
system/packages/package-transaction-security.selftest.mjs
system/packages/privileged-package-executor.mjs
system/packages/privileged-package-executor.selftest.mjs
system/packages/distribution-package-state.mjs
system/packages/distribution-package-state.selftest.mjs
system/packages/validate-package-transaction-service.mjs
system/contracts/package-transaction-journal.schema.json
system/contracts/package-snapshot.schema.json
system/contracts/package-health.schema.json
.github/workflows/system-package-transaction-contract.yml
```

The lifecycle self-tests cover successful commit, trust rejection, authorization rejection, command tampering, repository allowlisting, durable journal state, failed health verification, rpm-ostree rollback, restart recovery, corrupted-journal blocking, `shell=false`, environment isolation, root ownership checks and non-zero package-manager exit handling. They also exercise apt/rpm/pacman state parsing, missing-package state, native entry-point root confinement and executability, plus an integrated transaction using the real snapshot/health adapters with an injected non-mutating host runner.

The separate tamper-resistance suite verifies snapshot/health identity binding, rejects package-manager/source mismatches, rejects a journal copied under another transaction filename, rejects group/world-writable journal files and directories, and proves that a spoofed post-mutation health result cannot commit the transaction. Tests inject process/file probes and never modify the GitHub Actions host.

## Next production gates

Before the roadmap items **dependency-aware system package manager/updater** and **journaled driver/firmware/package transactions** can be checked complete, System Edition still needs:

- a production repository trust verifier backed by the selected distribution's package trust database;
- an active-session authorization broker and explicit polkit policy;
- VM validation of the new package/version snapshot adapters against the chosen base distribution;
- version-aware rollback for non-atomic package managers, or a filesystem/image snapshot strategy;
- richer package health probes tied to manifests, services and application-specific readiness where appropriate;
- integration with SWIR Update Center and Driver Center;
- VM tests that perform real install/update/remove/recovery against a disposable System Edition image;
- reboot/interruption tests proving recovery after power-loss-style termination.

Until those gates pass, this 0.1 implementation remains a guarded foundation rather than a declaration that the bootable System Edition package stack is complete.
