# SWIR Peer Authorization Broker 0.1

Status: **implemented Linux foundation / System-image E2E pending**

System Edition privileged services run outside the desktop user's process. A root daemon must therefore never assume that the active desktop user is the caller and must never accept a caller-supplied UID/PID. This component creates the missing identity handoff using Linux kernel peer credentials, `systemd-logind`, Polkit and a short-lived local grant.

## Security flow

```text
SWIR desktop/UI process
        |
        | AF_UNIX connection
        v
/run/swir/peer-authorization.sock
        |
        +--> kernel SO_PEERCRED -> pid / uid / gid
        +--> /proc/<pid>/stat   -> process start time
        +--> systemd-logind     -> active local Wayland/X11 session for same uid
        +--> /usr/bin/pkcheck   -> exact action + exact plan/resource details
        |
        v
short-lived HMAC-SHA256 authorization envelope
        |
        v
root SWIR package/network/firmware service
        |
        +--> root-only /run/swir/peer-authorization.key
        +--> MAC / TTL / request binding / replay check
        v
existing privileged transaction service
```

The unprivileged caller never sends a Unix PID, UID, GID or session identity. Those values come from `SO_PEERCRED` and `systemd-logind` on the broker side.

## Supported authorization domains

The 0.1 broker maps only the existing narrow SWIR Polkit domains: packages mutate/recover, NetworkManager activate/deactivate and firmware update/recover. Every grant is bound to the exact SHA-256 plan digest and resource identity.

## Active-session requirement

A valid Unix peer is not enough. Before Polkit is called, the broker uses the trusted distro `/usr/bin/loginctl` client and requires the peer UID to own an active, local, non-remote graphical `user`/`user-early` session of type Wayland or X11. UID 0 peers are rejected by this user-authorization channel. Polkit remains the privilege authority.

## Grant integrity and replay policy

On startup the broker creates a random 256-bit key at `/run/swir/peer-authorization.key`. The key is `0600`, root-owned in production, generated at runtime and never baked into the image. Authorization envelopes use HMAC-SHA256 over canonical JSON and default to a 10-second lifetime. The verifier checks key trust, constant-time MAC, issuer/audience, TTL, exact scope/action/operation/plan/resource binding, subject/session binding and one-time consumption.

## Native adapters

`system/ipc/peer-authorization-grant.mjs` exports `PeerAuthorizationClient`, `PeerAuthorizationGrantVerifier`, `PeerPackageAuthorizationBroker`, `PeerNetworkAuthorizationBroker` and `PeerFirmwareAuthorizationBroker`. `system/security/peer-package-security-boundary.mjs` provides an explicit peer-authorized package composition without weakening the existing current-process Polkit broker.

## System image integration

The supplemental rootfs provisioner installs the broker executable, systemd socket/service, systemd preset and tmpfiles declaration. The socket is preset-enabled, `/run/swir` is created at boot and the service is hardened with root ownership, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `RestrictAddressFamilies=AF_UNIX` and only `/run/swir` writable.

Socket mode is `0666` intentionally: any local desktop user may ask Polkit about their own kernel-derived subject. That does not grant privilege; caller-supplied identity and root peers are rejected and Polkit performs the authorization decision.

## Verification

Dedicated CI covers Python/Node syntax, real Linux `SO_PEERCRED`, cross-language Node -> Unix socket -> Python broker -> Polkit test double -> signed envelope -> Node verifier, explicit denial, tamper/expiry/replay checks, package/network/firmware adapters, systemd unit parsing, rootfs staging and proof that no runtime HMAC key is embedded in the image.

## Remaining production gates

1. Boot a disposable System Edition VM with the provisioned socket/service and real `systemd-logind` + `polkitd`.
2. Connect from the actual SWIR desktop user session and run real package/network transactions through a privileged service transport.
3. Add persistent privileged-daemon request transport that carries the envelope but never caller-supplied Unix identity.
4. Exercise login/logout, user switching, locked session, multiple seats and broker restart/key rotation.
5. Add service-level bounded replay persistence if future privileged operations can outlive a daemon restart during the short grant lifetime.

This is an authorization foundation, not evidence that System Edition is bootable or that login/session management is complete.
