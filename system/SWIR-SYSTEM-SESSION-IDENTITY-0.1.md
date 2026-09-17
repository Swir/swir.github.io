# SWIR System Session Identity 0.1

Status: **implemented read-only foundation / login-shell integration pending**

## Purpose

System Edition needs a native answer to a simple security question before privileged UI can become trustworthy: **which local user/session is actually active?** Web profiles are not sufficient evidence for Polkit, package, network or firmware authorization.

`SystemSessionIdentityService` adds a deliberately read-only systemd-logind adapter. It reads session state through the distribution `/usr/bin/loginctl` client and returns a normalized `swir.system-session-identity/0.1` record for one active local session.

## Trust and selection rules

Production mode is pinned to `/usr/bin/loginctl`. The binary must be a regular non-symlink executable, root-owned by default, and not writable by group/world. Commands use `execFile` semantics with `shell=false`, a bounded output buffer, timeout and a minimal environment.

A session is eligible only when all of these are true:

- it is reported as local (`Remote=no`);
- logind class is `user` or `user-early`;
- UID is at least 1000 by default;
- session is both `Active=yes` and `State=active`;
- it belongs to the requested seat (default `seat0`);
- graphical resolution requires `wayland` or `x11`.

The service refuses to guess when zero or multiple eligible sessions exist on the seat. Remote sessions, service UIDs and inactive sessions are never silently promoted to the active SWIR desktop identity.

`assertActorBinding()` lets a future IPC/privilege layer prove that an `actorId` and `sessionId` still refer to the currently active local session before opening a privileged interaction.

## Security boundary

This service **does not authenticate a password, grant privilege, change sessions, unlock the desktop, expose secrets or replace Polkit**. It only supplies local-session identity evidence. The existing Polkit brokers remain the privilege authority.

The correct long-term path is:

```text
SWIR shell / native IPC peer
        |
        v
systemd-logind session identity
        |
        +--> actor/session binding
        |
        v
narrow Polkit broker (package / network / firmware)
        |
        v
journaled privileged operation
```

A root service must not pretend its own UID is the desktop user. Future IPC work must bind the caller using native peer credentials and then reconcile that caller with this logind session evidence.

## Verification

The self-test covers active Wayland selection, remote-session exclusion, inactive-session exclusion, service-UID exclusion, actor/session mismatch rejection, non-graphical fallback only when explicitly requested, ambiguous-session fail-closed behavior, shell isolation and bounded command environment.

`system-session-host-probe.mjs` performs a real read-only host probe in CI. A CI runner may legitimately have no graphical logind session; that condition is reported rather than converted into a fake active user.
