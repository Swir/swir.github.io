# SWIR Desktop Permission Broker 0.3

## Goal

The Desktop Permission Broker is the first native authorization layer between `SwirRuntime` and Windows host capabilities. It exists so Desktop Edition does not trust app-supplied IDs or raw JavaScript calls as authority.

## Current trust model

Preview 0.3 creates one trusted execution context for `swir.system.shell` when the host starts. The context is bound to the host session and identified by a random 256-bit execution token that is injected into the native bridge closure but never exposed on `window.SWIR_NATIVE_HOST`.

Every native request must pass:

1. trusted `https://swir.local` source validation;
2. execution-context lookup;
3. session validation;
4. method-to-permission policy validation;
5. owner/application identity matching where a capability is app-owned;
6. capability validation where the operation targets an external resource.

Unknown surfaces/methods fail closed.

## Shell grants

The shell context currently receives only:

- `filesystem.sandbox.read`
- `filesystem.sandbox.write`
- `filesystem.picker`
- `filesystem.capability.read`
- `filesystem.capability.manage`
- `clipboard.read`
- `clipboard.write`
- `process.inspect`
- `runtime.inspect`

It does **not** receive `process.spawn`, `process.kill`, native network control, unrestricted external writes or updater-apply permissions.

## Runtime API

SWIR Runtime 1.2 adds:

```js
await SwirRuntime.security.context()
await SwirRuntime.security.can('filesystem.sandbox.read')
await SwirRuntime.security.isAuthenticated()
```

The native descriptor exposes identity, session, trust state and granted permission names, but never the execution token.

## Deliberate limitation

Preview 0.3 authenticates the shell, not individual third-party apps. Current apps share the shell WebView document, so a distinct app permission model would be unsafe without an isolated execution realm. For this reason, a native call claiming an app ID different from the authenticated context is rejected with `EXECUTION_IDENTITY_MISMATCH`.

## Desktop Edition path

The next architecture step is:

```text
VERIFIED INSTALLED PACKAGE
        -> isolated app execution realm
        -> host-created execution context
        -> packageId + session + granted permissions
        -> per-app native bridge
        -> capability broker
        -> native operation
```

The execution token must remain host-issued, session-scoped, non-persistent and inaccessible to unrelated app realms. Package permissions must come from the installed manifest plus user grants produced by the Secure Install Pipeline; they must never be accepted directly from app JavaScript.

## System Edition path

The same policy layer can later sit above a Linux/system native broker. Only the adapter implementation changes; the application permission vocabulary and fail-closed authorization flow should remain stable.
