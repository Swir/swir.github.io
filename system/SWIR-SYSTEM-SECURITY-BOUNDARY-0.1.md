# SWIR System Security Boundary 0.1

Status: **implemented foundation / base-image integration pending**

This layer provides concrete, fail-closed authorization and source-trust boundaries for privileged System Edition work. Package transactions remain the first fully composed native mutation path, while NetworkManager and fwupd/LVFS now use dedicated Polkit brokers and deliberately narrower operation sets. None of these foundations marks a System Edition roadmap deliverable complete until a maintained target image passes native E2E.

## Native authorization domains

The System Edition authorization registry now contains three non-overlapping domains:

```text
packages.mutate    -> org.swir.system.packages.mutate
packages.recover   -> org.swir.system.packages.recover
network.activate   -> org.swir.system.network.activate
network.deactivate -> org.swir.system.network.deactivate
firmware.update    -> org.swir.system.firmware.update
firmware.recover   -> org.swir.system.firmware.recover
```

The corresponding brokers are:

```text
PolkitSystemAuthorizationBroker
PolkitNetworkAuthorizationBroker
PolkitFirmwareAuthorizationBroker
```

All three pin production authorization to `/usr/bin/pkcheck`, require a root-owned non-symlink binary that is not group/world writable, execute with `shell=false` and a minimal environment, and bind the authorization subject to the current process `pid,start-time,uid`. A caller cannot substitute another Unix subject.

Every mutation domain also binds authorization to a deterministic SHA-256 plan digest plus the minimum identity needed for the operation: package ID/operation, connection UUID/interface/operation, or firmware device/release/operation. User interaction is disabled unless a trusted caller explicitly asks for it.

The policy files are intended to be installed by the future base image into the distribution PolicyKit action directory with root ownership. Source files in the repository grant no privilege on their own.

## Policy separation

The package and firmware actions require administrator authentication. Network 0.1 is narrower: it can only activate or deactivate an **existing saved** NetworkManager profile and therefore uses authenticated active-user policy; profile creation/modification/deletion and secret submission remain outside that broker.

The validator requires the XML action set for every domain to match the action IDs exported by its broker exactly. It also rejects:

- duplicate action IDs between native domains;
- non-`org.swir.system.*` action IDs;
- `allow_any=yes`;
- unauthenticated `allow_inactive=yes` or `allow_active=yes`;
- missing root PolicyKit ownership annotation;
- a broker that enables shell execution;
- a mutation broker that stops binding the exact plan digest;
- arbitrary `nmcli` or `fwupdmgr` argument surfaces.

This makes adding a new privileged domain an explicit registry change instead of silently placing another action file beside the existing package policy.

## Package repository trust path

`DistributionRepositoryTrustVerifier` requires a root-owned deployment policy using schema `swir.system-repository-trust-policy/0.1`. The policy maps a logical SWIR repository ID to the selected native package manager, native repository identifier, supported distribution IDs, `distribution-repository` source class, mandatory native signature verification and an explicit ban on insecure repository mode.

Install/update operations perform a read-only native package-manager probe before mutation. The probes use fixed absolute binaries and argument arrays with `shell=false` and a minimal environment:

```text
apt        -> apt-cache policy <package>
dnf        -> dnf --disablerepo=* --enablerepo=<id> repoquery ...
rpm-ostree -> rpm-ostree status --json
pacman     -> pacman -Sl <repo> <package>
zypper     -> zypper --xmlout search --match-exact --repo <repo> <package>
```

Remove operations do not require remote availability because they do not fetch a new package; they still require root-owned repository policy and transaction authorization. `repository-trust-policy.example.json` intentionally uses `example.invalid`, so copying the template without real image provisioning fails closed.

## Package composition

`createSystemPackageSecurityBoundary()` composes package authorization and distribution-repository trust and supplies the repository allowlist to `SystemPackageTransactionService`:

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

NetworkManager and firmware deliberately keep separate brokers rather than reusing package authorization. Their operation identities and recovery semantics are different, so sharing a broad `system.mutate` privilege would weaken the boundary.

## Machine-readable contracts

Package trust remains described by:

```text
system/contracts/system-authorization-grant.schema.json
system/contracts/repository-trust-policy.schema.json
system/contracts/repository-trust-proof.schema.json
```

Network and firmware surfaces additionally have their own inventory/journal contracts and dedicated integration documents. The cross-domain validator checks native PolicyKit action registration directly against the broker policy exports.

## Verification

The System Security Boundary CI now covers the package, network and firmware authorization domains together:

- exact broker-to-PolicyKit action registration;
- duplicate action rejection across domains;
- PolicyKit XML parsing;
- current-process PID/start-time/UID actor binding;
- plan-digest and resource-identity binding;
- no user interaction unless explicitly requested;
- trusted `pkcheck` ownership/mode requirements;
- shell/environment isolation;
- authorization denial and actor mismatch paths;
- NetworkManager no-secret/no-arbitrary-argument behavior through its service self-test;
- firmware LVFS source binding, guarded command and reboot-aware recovery through its transaction self-test;
- package repository fail-closed validation and composed allowlist wiring;
- JSON contract parsing;
- read-only host security probing.

Dedicated NetworkManager and firmware workflows remain in place as narrower component gates; the security-boundary workflow is the cross-domain regression gate.

## Remaining production gates

1. Provision the package, network and firmware PolicyKit action files into a disposable System Edition image with root ownership and test them against the image's real polkitd/session model.
2. Provision a real `/etc/swir/repository-trust-policy.json` tied to the selected base distribution repositories and signed System update path.
3. Add a native SWIR session/identity broker so UI authorization prompts map cleanly to the active desktop user while Polkit remains the privilege authority.
4. Run real package install/update/remove/recovery vectors plus NetworkManager Ethernet/Wi-Fi reconnect vectors in disposable VMs.
5. Run firmware mutation/reboot/reconciliation on supported physical LVFS hardware; do not infer hardware safety from software fixtures.
