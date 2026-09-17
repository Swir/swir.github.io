# SWIR System Session Identity 0.1

Status: **implemented foundation / System image integration pending**

## Purpose

System Edition needs a trustworthy mapping between the active SWIR desktop user and the Unix session model before privileged UI flows can be wired to Polkit. This component adds a read-only `systemd-logind` session identity boundary. It does not authenticate users and it does not grant privilege.

The production adapter is pinned to the distribution-owned `/usr/bin/loginctl`. Before use it requires a root-owned, executable, non-symlink binary that resolves to the allowlisted path and is not writable by group or world. Every call uses `execFile` semantics with `shell=false`, a minimal environment, bounded output and a timeout.

## Session selection

`SystemSessionIdentityService` enumerates session IDs and fetches an explicit property set for each session. An attestation is issued only when the current Unix process UID maps to exactly one session satisfying all of these conditions:

```text
Remote=no
Active=yes
Type=wayland|x11
Class=user|user-early
User=<current process uid>
```

A missing desktop session fails closed. Multiple matching active desktop sessions are treated as ambiguous and also fail closed. Callers cannot select an arbitrary UID or session ID for attestation.

## Attestation

`attestCurrentProcess()` emits `swir.system-session-attestation/0.1` containing:

- `actorId=uid:<uid>` compatible with the current System authorization actor convention;
- a session-scoped `sessionActorId`;
- logind session id, username, seat, type, class and state;
- the current process PID, Unix UID and `/proc` start time;
- a SHA-256 digest over the normalized session plus process subject;
- the explicit authorities `systemd-logind-read-only` and `polkit-separate`.

The digest is an integrity binding inside the trusted service boundary, not a cryptographic identity signature. Polkit remains the authorization authority. This avoids turning login/session discovery into a second privilege system.

## Security properties

0.1 intentionally does **not** expose:

- arbitrary `loginctl` arguments;
- arbitrary UID/session impersonation;
- session termination, locking or user mutation;
- environment/session secrets;
- privilege grants;
- remote sessions as local desktop actors.

This service is intended to be composed with future SWIR shell/login work and the existing package/network/firmware Polkit brokers. The next integration step is to transport the attestation from the unprivileged desktop/session side across a narrow native IPC boundary without allowing the privileged service to trust caller-supplied PIDs or UIDs.

## Completion gate

The System Edition roadmap item **SWIR boot splash and login/session manager** remains incomplete. A read-only active-session identity service is only a prerequisite. Completion requires the real System image to boot into a SWIR-managed login/session flow, create the desktop session, survive logout/login/restart paths and pass VM/hardware E2E.
