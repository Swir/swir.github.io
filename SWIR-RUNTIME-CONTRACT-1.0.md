# SWIR Runtime Adapter Contract 1.1

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

The Windows Desktop Host Preview 0.2 implements this lifecycle:

```text
USER PICKER
   -> opaque capability token
   -> native host validates token + kind + expiry
   -> operation executes inside granted scope
   -> revoke / expiry / host restart
```

Current native capability methods:

```text
filesystem.capabilityInfo(token)
filesystem.readCapabilityText(token)
filesystem.revokeCapability(token)
filesystem.pruneCapabilities()
```

Picker results contain a random opaque token, resource kind, display name, issue/expiry timestamps and non-sensitive metadata. They do not include `nativePath`.

Tokens in Preview 0.2:

- use 192 bits of cryptographic randomness;
- expire after 30 minutes;
- are revocable;
- are stored in memory only;
- are all revoked implicitly when the host exits;
- validate resource kind before protected operations.

Future revisions should bind each token to the requesting application/package identity and its permission grant.

## Native host injection

Desktop/System hosts inject `window.SWIR_NATIVE_HOST` before `swir-runtime.js` loads. Each provided surface replaces the Web fallback for that surface only.

## Windows Desktop Host Preview 0.2

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
filesystem.pruneCapabilities
clipboard.readText
clipboard.writeText
clipboard.clear
processes.list
processes.open
```

The normal SWIR filesystem remains sandboxed under the current user's local application-data area. External resources require an explicit Windows picker. Raw native paths no longer cross the JavaScript/native boundary.

`processes.spawn` and `processes.kill` remain denied with `PERMISSION_DENIED` until the Desktop permission broker exists. Network control, tray integration and native updates are not exposed by the host yet.

## Security rules

- Native hosts must validate every privileged request; JavaScript input is untrusted.
- Runtime adapters do not bypass SWIR package permissions or install-pipeline checks.
- Real external filesystem access should use revocable capability tokens, not arbitrary paths.
- `processes.spawn`, native network control and updater apply remain unavailable until explicit brokers exist.
- Package verification and permission approval remain separate gates before native installation or execution.
- Desktop bridges should expose allowlisted operations only.

## Diagnostics

`SwirRuntime.info()` reports the active edition, provider and available methods per surface.

`SwirRuntime.capabilities()` reports whether each surface is supplied by a native host or by the Web adapter.

The SWIR terminal command `runtime` prints the same capability map.

## Migration path

1. Web Edition validates application contracts using browser fallbacks.
2. Desktop Edition injects a lightweight native host and progressively implements privileged services behind brokers.
3. Windows Preview 0.2 establishes capability-token external filesystem access.
4. The next Desktop milestone should add a permission broker and bind capabilities to package/app identity.
5. System Edition can replace the Desktop implementation with Linux-native services while preserving `swir.runtime/1.0` where possible.
