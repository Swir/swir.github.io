# SWIR System Security Boundary 0.1

Status: **implemented foundation / base-image integration pending**

This layer provides concrete, fail-closed authorization and source-trust boundaries for privileged System Edition work. Package transactions remain the first fully composed native mutation path, while NetworkManager and fwupd/LVFS use dedicated Polkit brokers and deliberately narrower operation sets. A new peer-credential broker now closes the earlier identity-attribution gap between an unprivileged desktop process and future root SWIR daemons. None of these foundations marks a System Edition roadmap deliverable complete until a maintained target image passes native E2E.

## Native authorization domains

The authorization registry contains package mutate/recover, NetworkManager activate/deactivate and firmware update/recover actions. Existing current-process brokers remain pinned to `/usr/bin/pkcheck` and bind authorization to the current process PID/start-time/UID.

For privileged daemon composition, System Edition now also has `swir-peer-authorization-broker`. It accepts an AF_UNIX connection, derives PID/UID/GID with Linux `SO_PEERCRED`, checks that the same UID owns an active local graphical `systemd-logind` session, asks Polkit about that exact peer process, and emits a short-lived HMAC-authenticated envelope. The client cannot substitute PID/UID/GID/session values and root peers are rejected on this desktop-user path.

Every mutation domain binds authorization to a deterministic SHA-256 plan digest plus the minimum resource identity needed for the operation. User interaction is disabled unless explicitly requested.

## Peer grant boundary

The broker creates `/run/swir/peer-authorization.key` at runtime with 32 random bytes and mode `0600`; the key is never embedded in the rootfs. Root-side verifiers require the exact request binding, bounded TTL, active local session evidence and one-time consumption. Modified, expired, replayed or resource-mismatched grants fail closed.

`PeerPackageAuthorizationBroker`, `PeerNetworkAuthorizationBroker` and `PeerFirmwareAuthorizationBroker` translate verified envelopes into the existing grant schemas. `createPeerAuthorizedSystemPackageSecurityBoundary()` provides an explicit package composition for future root package daemons while the existing current-process composition remains available and is not silently weakened.

## Package repository trust path

`DistributionRepositoryTrustVerifier` still requires a root-owned deployment policy with native signature verification and no insecure mode. Install/update operations perform read-only native package-manager probes before mutation; remove operations still require trusted policy and authorization.

## Verification

The peer authorization contract adds real Linux socket E2E coverage: connecting-process PID/UID/GID from `SO_PEERCRED`, active local Wayland/X11 session binding, exact Polkit action + plan/resource detail binding, explicit authorization denial, runtime HMAC key rules, tamper/expiry/replay rejection, package/network/firmware adapter compatibility and systemd/tmpfiles rootfs artifact staging with tamper detection.

Existing workflows continue to cover PolicyKit XML, current-process brokers, repository trust, NetworkManager restrictions, firmware LVFS source binding and transaction recovery.

## Remaining production gates

1. Provision package/network/firmware policies and the peer-authorization units into a disposable System Edition image and test them against real `polkitd`, `logind` and systemd socket activation.
2. Provision a real `/etc/swir/repository-trust-policy.json` tied to the selected base distribution repositories and signed System update path.
3. Add the privileged daemon request transport that carries peer envelopes into package/network/firmware services without accepting caller-supplied Unix identity.
4. Run real package install/update/remove/recovery and NetworkManager reconnect vectors in disposable VMs from a real SWIR desktop session.
5. Run firmware mutation/reboot/reconciliation on supported physical LVFS hardware; do not infer hardware safety from software fixtures.
