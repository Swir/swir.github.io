# SWIR Runtime Adapter Contract 1.1.1

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
SwirRuntime.processes
SwirRuntime.clipboard
SwirRuntime.tray
SwirRuntime.network
SwirRuntime.updater
```

The Web Edition delegates compatible operations to `SwirPlatform` and browser APIs. Unsupported privileged operations fail explicitly with `RUNTIME_UNSUPPORTED`.

## Filesystem capability model

Desktop/System hosts must not expose stable raw OS paths to untrusted application code when a narrower capability can represent the same access.

Windows Desktop Host Preview 0.2.1 uses:

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

Tokens use 192 bits of cryptographic randomness, expire after 30 minutes, remain memory-only and are invalidated when the host exits. External text reads are capped at 2 MiB in Preview 0.2.1.

Portable applications should prefer the app-scoped facade:

```js
const fs = SwirRuntime.filesystem.forApp('swir.example.notes');
const picked = await fs.pickFile();
const text = picked ? await fs.readCapabilityText(picked.token) : null;
await fs.revokeAllCapabilities();
```

Legacy/root Runtime calls remain compatible and default to `swir.system.shell`.

## Security boundary

App-ID ownership in Preview 0.2.1 is a containment primitive, not authenticated authorization. The current same-origin WebView shell can still claim another app ID. Therefore the Desktop host must continue to deny process spawning/termination, native network control, unrestricted external writes and updater apply until an authenticated Permission Broker can bind native calls to a trusted package execution context and approved SWIR permission grant.

## Native host injection

Desktop/System hosts inject `window.SWIR_NATIVE_HOST` before `swir-runtime.js` loads. Each provided surface replaces the Web fallback for that surface only. The host also publishes an ephemeral `sessionId` for diagnostics; applications must not treat it as a secret or authorization token.

## Windows Desktop Host Preview 0.2.1

The concrete Desktop Edition host lives in `desktop/windows/` and targets .NET 8 + Microsoft WebView2.

Implemented native surfaces:

```text
filesystem.list
filesystem.get
filesystem.save
filesystem.remove
filesystem.pickFile
filesystem.pickDirectory
filesystem.capabilityInfo
filesystem.readCapabilityText
filesystem.revokeCapability
filesystem.revokeOwnerCapabilities
filesystem.pruneCapabilities
filesystem.capabilityStatus
clipboard.readText
clipboard.writeText
clipboard.clear
processes.list
processes.open
```

The normal SWIR filesystem remains sandboxed under the current user's local application-data area. External resources require an explicit Windows picker. Raw native paths do not cross the JavaScript/native boundary.

## Security rules

- Treat all JavaScript/native bridge input as untrusted.
- Never treat an app-supplied ID alone as proof of identity.
- Runtime adapters do not bypass SWIR package permissions or install-pipeline checks.
- External filesystem access should use revocable capabilities rather than arbitrary paths.
- Validate capability session, owner, kind, expiry and resource state before use.
- Keep dangerous native operations fail-closed until their broker exists.
- Package verification and permission approval remain separate gates before native installation or execution.
- Desktop bridges expose allowlisted operations only.

## Diagnostics

`SwirRuntime.info()` reports active edition, provider, native session ID when present, and available methods per surface.

`SwirRuntime.capabilities()` reports whether each surface is supplied by a native host or Web adapter.

`SwirRuntime.filesystem.capabilityStatus()` exposes non-secret broker diagnostics such as active grant count, lifetime and text-read limit.

## Migration path

1. Web Edition validates portable application contracts using browser fallbacks.
2. Desktop Edition injects a lightweight native host and progressively implements privileged services behind brokers.
3. Preview 0.2 introduced opaque filesystem capability tokens.
4. Preview 0.2.1 binds grants to the current host session and an owner app identity while preserving fail-closed privileged operations.
5. Next milestone: authenticated app execution context + Desktop Permission Broker mapped to installed package grants.
6. Then add scoped directory capabilities, tray, updater staging and tightly allowlisted process services.
7. System Edition can replace the Desktop implementation with Linux-native services while preserving `swir.runtime/1.0` where possible.
