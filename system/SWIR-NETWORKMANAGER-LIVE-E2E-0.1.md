# SWIR NetworkManager Live E2E 0.1

## Purpose

This gate verifies the System Edition `NetworkManagerService` against a real distro NetworkManager daemon and the production `/usr/bin/nmcli` client. The daemon is started inside a private Linux network + mount + PID namespace with a dummy interface and tmpfs-backed runtime/state directories, so the test does not alter the CI host network or require external connectivity.

The integration remains deliberately narrower than exposing `nmcli` directly. Applications receive normalized inventory and can only request activation/deactivation of an already saved profile through a structured, digest-bound plan and authorization boundary.

## Verified path

```text
private Linux network namespace
        |
        +--> private /run + D-Bus system bus
        +--> private NetworkManager state
        +--> dummy interface swir0
        +--> saved test profile
        |
        v
real NetworkManager daemon
        |
        v
root-owned /usr/bin/nmcli
        |
        v
SWIR NetworkManagerService
        +--> read-only normalized inventory
        +--> no secrets
        +--> exact activation plan + SHA-256 digest
        +--> authorization grant bound to plan/profile
        +--> real connection up
        +--> verified active postcondition
        +--> exact deactivation plan + SHA-256 digest
        +--> real connection down
        +--> verified inactive postcondition
```

## Isolation and safety

- The workflow creates a private network namespace; no physical or host interface is modified.
- `/run`, `/var/lib/NetworkManager` and `/etc/NetworkManager/system-connections` are tmpfs mounts visible only inside the mount namespace.
- The test profile uses a dummy interface, has no IPv4/IPv6 addressing, and requires no external network.
- The production service remains pinned to `/usr/bin/nmcli`, requires a trusted root-owned executable, uses `execFile` with `shell=false`, bounded output and a restricted environment.
- The service does not expose raw nmcli arguments, secret display, arbitrary profile creation or arbitrary connection UUIDs outside the structured operation.
- Mutations are bound to the exact plan digest. Production Polkit/session authorization is tested by the existing security-boundary and peer-authorization suites; this lane isolates and proves the real NetworkManager execution/postcondition side of that boundary.

## Evidence

Success emits `swir.networkmanager-live-e2e/0.1` proving trusted distro nmcli, normalized inventory, a real activation and deactivation through NetworkManager, digest-bound authorization, no secret exposure, and no host-network mutation claim.

This gate does not claim Wi-Fi radio qualification, VPN plugin coverage, enterprise authentication, captive portal behavior or physical adapter qualification. Those remain later hardware/system qualification work.

## Roadmap interpretation

Combined with the existing production service, Polkit network broker, peer-credential authorization boundary and booted-image NetworkManager readiness checks, a green exact-revision run of this gate is sufficient evidence for the scoped System Edition roadmap item **NetworkManager integration**. It does not imply the whole System Edition networking stack or physical hardware matrix is complete.
