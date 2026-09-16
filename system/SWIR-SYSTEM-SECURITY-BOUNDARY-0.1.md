# SWIR System Package Security Boundary 0.1

Status: **implemented foundation / base-image integration pending**

This layer replaces the transaction service's placeholder authorization/trust dependencies with concrete, fail-closed System Edition adapters. It does not mark the System Edition package-manager roadmap complete yet: a bootable base image still has to install the policy files, provision real repository IDs, and pass VM/hardware end-to-end mutation/recovery tests.

## Authorization path

`PolkitSystemAuthorizationBroker` maps only these transaction scopes:

```text
packages.mutate  -> org.swir.system.packages.mutate
packages.recover -> org.swir.system.packages.recover
```

The broker invokes `/usr/bin/pkcheck` directly with `shell=false`. Before invocation it requires the binary to be a root-owned, non-symlink regular file that is not group/world writable. The authorization subject is the current System service process bound as `pid,start-time,uid`; callers cannot select another Unix subject. The request binds the Polkit check to the package ID, operation and SHA-256 plan digest through explicit Polkit details.

User interaction is disabled by default. A trusted shell can request `allowUserInteraction=true`; the shipped policy still requires administrator authentication. `org.swir.system.packages.recover` deliberately uses the stronger non-cached active-session rule.

`system/security/org.swir.system.packages.policy` is intended to be installed by the future immutable/base image into the distribution's PolicyKit action directory with root ownership. The source file itself grants no privilege until the System image installs it in the native policy location.

## Repository trust path

`DistributionRepositoryTrustVerifier` requires a root-owned deployment policy using schema `swir.system-repository-trust-policy/0.1`. The policy maps a logical SWIR repository ID to:

- the selected native package manager,
- a native repository identifier,
- supported distribution IDs,
- `distribution-repository` source class,
- mandatory native signature verification,
- an explicit ban on insecure repository mode.

Install/update operations also perform a read-only native package-manager probe before mutation. The probes use fixed absolute binaries and argument arrays with `shell=false` and a minimal environment:

```text
apt        -> apt-cache policy <package>
dnf        -> dnf --disablerepo=* --enablerepo=<id> repoquery ...
rpm-ostree -> rpm-ostree status --json
pacman     -> pacman -Sl <repo> <package>
zypper     -> zypper --xmlout search --match-exact --repo <repo> <package>
```

Remove operations do not require remote availability because they do not fetch a new package; they still require the root-owned repository policy and transaction authorization.

The repository policy is an image/deployment input, not user-controlled Store metadata. `repository-trust-policy.example.json` intentionally uses `example.invalid` so copying the template without provisioning fails closed instead of authorizing a real mirror accidentally.

## Composition

`createSystemPackageSecurityBoundary()` composes the two adapters and exposes the repository IDs that may be passed to `SystemPackageTransactionService` as its `allowlistedRepositories` set:

```text
DistributionPackageProvider
       |
       v
SystemPackageTransactionService
       |
       +--> DistributionRepositoryTrustVerifier
       |       +--> root-owned repository policy
       |       +--> native read-only package-manager probe
       |
       +--> PolkitSystemAuthorizationBroker
       |       +--> current pid/start-time/uid subject
       |       +--> package/op/plan-digest details
       |
       +--> durable transaction journal
       +--> guarded privileged package executor
```

The composed boundary does not execute package mutations itself and therefore does not bypass the existing transaction journal or guarded executor.

## Machine-readable contracts

```text
system/contracts/system-authorization-grant.schema.json
system/contracts/repository-trust-policy.schema.json
system/contracts/repository-trust-proof.schema.json
```

The trust proof carries the exact logical/native repository IDs, package manager, distribution, package name, operation, policy SHA-256 and evidence class. The authorization grant carries the Polkit action, current Unix actor, package identity, operation and plan digest.

## Verification

The CI suites cover:

- exact Polkit scope/action mapping,
- current-process subject binding including `/proc` start time,
- actor mismatch rejection,
- no user interaction unless explicitly requested,
- root ownership/mode checks for `pkcheck`,
- shell/environment isolation,
- authorization denial,
- repository policy fail-closed validation,
- distribution/manager binding,
- package availability evidence for trusted repositories,
- root ownership checks for package-manager probe binaries,
- composed boundary allowlist wiring,
- JSON contract parsing,
- policy action hardening (`allow_any=yes` is forbidden).

## Remaining production gates

1. Provision a real `/etc/swir/repository-trust-policy.json` from the selected base distribution image build, with repository IDs tied to the exact base-image repository configuration.
2. Install and ownership-verify the Polkit action file in a disposable System Edition VM.
3. Add a native service identity/session broker so UI prompts can identify the active SWIR user/session while Polkit remains the privilege authority.
4. Run real install/update/remove and rpm-ostree recovery vectors in disposable VMs with network/repository failures injected.
5. Bind repository-policy updates to the signed System update path rather than ordinary writable application data.
