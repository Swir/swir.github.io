# SWIR System Session Identity 0.1

Status: **implemented read-only foundation / image and IPC integration pending**

System Edition needs a native identity/session source that does not trust browser state, caller-provided usernames or environment variables. This foundation uses the distribution `systemd-logind` client (`/usr/bin/loginctl`) only as a read-only evidence source.

## Security model

`SystemSessionIdentityService`:

- pins production discovery to `/usr/bin/loginctl`;
- requires a root-owned, executable, non-symlink binary that is not group/world writable;
- invokes only `list-sessions` and `show-session` with fixed property names;
- uses `shell=false`, a minimal environment, bounded output and bounded session count;
- never reads passwords, authentication tokens or NetworkManager secrets;
- never creates, kills, locks, unlocks or switches a session;
- ignores remote, inactive, non-user, non-graphical and UID 0 sessions for active-user attribution;
- prefers an active local Wayland/X11 user session on `seat0` when several eligible sessions exist.

The selected actor uses a portable identity shape:

```text
uid -> actorId (uid:<number>)
session id
username
seat
Wayland/X11 type
leader PID
```

This is **session attribution**, not an authentication bypass. `authenticatedBySessionManager` remains `false`: logind tells SWIR which native session is active, but Polkit/PAM remain the authorities for privileged authentication.

## Authorization binding

`createSessionBoundAuthorizationContext()` is deliberately strict. A desktop-shell process may convert the selected actor into the existing Polkit broker context only when the process Unix UID exactly matches the session UID. A future root/system daemon must use authenticated IPC peer credentials; it cannot impersonate the graphical user merely because logind reports that user as active.

This closes an important migration gap between the Desktop local-profile model and System Edition native account/session security without weakening the existing current-process Polkit subject binding.

## Contract

Machine-readable inventory is defined by:

```text
system/contracts/system-session-inventory.schema.json
```

Live read-only diagnostics can be generated with:

```bash
node system/session/system-session-probe.mjs
```

A host without a usable logind client returns a fail-closed unavailable inventory instead of inventing an identity.

## Remaining production gates

1. Provision `systemd-logind` and the SWIR graphical session in a disposable System Edition image.
2. Add an authenticated IPC peer-credential broker for privileged services that execute outside the desktop user's Unix process.
3. Map PAM/login/display-manager lifecycle into SWIR lock/unlock/login UI without storing native credentials in the web runtime.
4. Verify multi-seat, fast-user-switching, suspend/resume and logout races in a real Wayland session.
5. Bind package/network/firmware UI prompts to the resolved session actor while keeping Polkit as the authorization authority.
