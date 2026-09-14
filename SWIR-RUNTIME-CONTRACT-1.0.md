# SWIR Runtime Adapter Contract 1.1.2

## Goal

`swir.runtime/1.0` remains the stable edition boundary for SWIR OS. Applications and system modules target one runtime surface while Web, Desktop and System editions provide different implementations underneath.

```text
SWIR App / SWIR Service
        |
        v
   SwirRuntime
        |
        +--> Web Adapter
        +--> Desktop Native Host
        +--> System Native Host
```

## Runtime surfaces

```text
SwirRuntime.filesystem
SwirRuntime.appData
SwirRuntime.packages
SwirRuntime.processes
SwirRuntime.services
SwirRuntime.clipboard
SwirRuntime.tray
SwirRuntime.network
SwirRuntime.devices
SwirRuntime.identity
SwirRuntime.updater
SwirRuntime.security
```

The Web Edition delegates compatible operations to `SwirPlatform` and browser APIs. Unsupported privileged operations fail explicitly with `RUNTIME_UNSUPPORTED`.

## Filesystem capability model

Desktop/System hosts must not expose stable raw OS paths to untrusted application code when a narrower capability can represent the same access.

The Windows Desktop Host uses:

```text
USER PICKER
   -> opaque random capability token
   -> bind to host session + owner app ID
   -> validate token + session + owner + kind + expiry + resource
   -> operation executes inside granted scope
   -> revoke / expiry / host restart
```

Current native capability methods:

```text
filesystem.capabilityInfo(token, ownerAppId)
filesystem.readCapabilityText(token, ownerAppId)
filesystem.revokeCapability(token, ownerAppId)
filesystem.revokeOwnerCapabilities(ownerAppId)
filesystem.pruneCapabilities()
filesystem.capabilityStatus()
```

Tokens use cryptographic randomness, remain session-scoped and are invalidated when the host exits. External resources remain capability-gated; raw native paths are not the portable application contract.

Portable applications should prefer the app-scoped facade:

```js
const fs = SwirRuntime.filesystem.forApp('swir.example.notes');
const picked = await fs.pickFile();
const text = picked ? await fs.readCapabilityText(picked.token) : null;
await fs.revokeAllCapabilities();
```

Legacy/root Runtime calls remain compatible and default to `swir.system.shell`.

## Security boundary

Desktop native calls are bound to authenticated host execution-context tokens issued by the `PermissionBroker`. The trusted shell receives a host-owned execution context; installed packages receive package-scoped contexts synchronized from approved package permissions and execution policy.

A caller-supplied app/package identifier is not treated as authority by itself. Privileged behavior remains fail-closed when no explicit permission policy exists.

The Desktop Host currently keeps process/service mutation, native network control and similar high-risk operations disabled unless a dedicated broker, permission and recovery contract exists.

## Native host injection

Desktop/System hosts inject `window.SWIR_NATIVE_HOST` before `swir-runtime.js` loads. Each provided surface replaces the Web fallback for that surface only. The host also publishes an ephemeral `sessionId` for diagnostics; applications must not treat it as a secret or authorization token.

## Windows Desktop Host Preview 0.5.5

The concrete Desktop Edition host lives in `desktop/windows/` and targets .NET 8 + Microsoft WebView2.

Implemented native surfaces include:

```text
filesystem.info/list/get/save/remove
filesystem.pickFile/pickDirectory
filesystem capability inspection/read/revoke/status
appData.info/list/get/set/remove
packages.info/installFromCapability/status/rollback
clipboard.readText/writeText/clear
processes.info/list
services.info/list
network.status/adapters
devices.info/list
identity.info/account/session
security context/policy/isolation/package-context inspection
updates readiness/check/prepare/cancel/reset/applyAndRestart
```

The normal SWIR filesystem remains sandboxed under the current user's local application-data area. External resources require an explicit Windows picker/capability. Raw native paths do not cross the portable JavaScript/native boundary.

### Clipboard

The shipping Desktop Host maps the portable clipboard surface to the Windows clipboard API. Reads require `clipboard.read`; writes and clear require `clipboard.write`.

### Desktop tray lifecycle

Desktop Host Preview 0.5.5 owns a native Windows notification-area icon through `DesktopTrayIcon` and a deterministic `DesktopTrayLifecycle` state machine.

```text
VISIBLE
  | minimize / user close
  v
HIDDEN IN TRAY
  | Show / double click
  v
VISIBLE

VISIBLE/HIDDEN
  | explicit Exit or verified update-restart shutdown
  v
EXITING -> DISPOSED
```

The tray is host-owned. Ordinary window close and minimize can hide the Desktop Host without terminating it. Explicit tray Exit and the guarded update-restart lifecycle mark the host as exiting before normal Form shutdown, so update activation cannot be accidentally converted into hide-to-tray.

The current tray integration intentionally does not expose arbitrary native tray mutation directly to package code. `SwirRuntime.tray` retains its portable Web fallback while future package-visible Desktop tray operations require an explicit permissioned broker contract.

### Process and service inventory

Desktop process/service integration is currently read-only. Task Manager and SWIR Services can consume native inventory through `SwirRuntime` without exposing command lines, executable paths, environment variables, credentials or tokens. Process/service mutation remains disabled.

### Identity and device/network

Desktop identity/session, device inventory and adapter inventory are native read-only surfaces. They are designed to keep portable UI independent from the eventual Linux System Edition implementation.

## Security rules

- Treat all JavaScript/native bridge input as untrusted.
- Never treat an app-supplied ID alone as proof of identity.
- Runtime adapters do not bypass SWIR package permissions or install-pipeline checks.
- External filesystem access should use revocable capabilities rather than arbitrary paths.
- Validate capability session, owner, kind, expiry and resource state before use.
- Keep dangerous native operations fail-closed until their broker exists.
- Package verification and permission approval remain separate gates before native installation or execution.
- Desktop bridges expose allowlisted operations only.
- Host-owned tray/update lifecycle must not be bypassed by arbitrary process termination.

## Diagnostics

`SwirRuntime.info()` reports active edition, provider, native session ID when present, native feature flags and available methods per surface.

`SwirRuntime.capabilities()` reports whether each surface is supplied by a native host or Web adapter.

`SwirRuntime.filesystem.capabilityStatus()` exposes non-secret broker diagnostics such as active grant count and capability limits.

## Migration path

1. Web Edition validates portable application contracts using browser fallbacks.
2. Desktop Edition injects a lightweight native host and progressively implements privileged services behind brokers.
3. Filesystem access moved to opaque, owner/session-bound capability tokens.
4. Package execution contexts and the Desktop Permission Broker bind native calls to installed-package grants.
5. Native account/session, device/network and process/service inventory now run behind portable adapters.
6. Native clipboard and host-owned tray lifecycle provide the next desktop-shell integration layer.
7. Next targets: global shortcuts/native file associations, stronger native notification/tray brokerage and the remaining Desktop packaging/runtime hardening.
8. System Edition replaces Windows adapters with Linux-native services while preserving `swir.runtime/1.0` where practical; Windows applications use a managed Wine/Proton compatibility layer rather than pretending Windows binaries are Linux-native.
