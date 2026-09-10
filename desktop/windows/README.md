# SWIR OS Desktop Host — Windows Preview 0.3

This is the native-host line for SWIR OS Desktop Edition.

## What it does

- hosts the existing SWIR shell in Microsoft WebView2;
- maps the repository root to the isolated `https://swir.local/` virtual origin;
- injects `window.SWIR_NATIVE_HOST` before application scripts run;
- implements the stable `swir.runtime/1.0` boundary;
- adds an in-memory Desktop Permission Broker with authenticated host-session execution contexts;
- requires a non-exported 256-bit execution token on every native bridge request;
- authorizes every native method through a method-to-permission policy map;
- rejects owner/app identity mismatches before capability resolution;
- accepts native bridge messages only from the `https://swir.local` origin;
- provides native clipboard access and a sandboxed filesystem under `%LOCALAPPDATA%\SWIR\DesktopHost\Data`;
- converts user-selected external files/folders into revocable capability tokens instead of returning raw OS paths;
- keeps process spawn/kill denied because the shell context is not granted those capabilities.

## Requirements

- Windows 10/11
- .NET 8 SDK
- Microsoft Edge WebView2 Runtime

## Run from the repository

```powershell
cd desktop\windows
dotnet restore
dotnet run
```

The host walks upward from its build directory until it finds the repository `index.html`, then serves the checkout through the WebView2 virtual host.

## Security model

Preview 0.3 follows least privilege:

- native calls require a valid execution context token tied to the current host session;
- the token is captured inside the injected bridge closure and is not exported through `window.SWIR_NATIVE_HOST`;
- the bridge binds `chrome.webview.postMessage` before page scripts run, reducing token interception through later monkey-patching;
- every method is mapped to a named permission such as `filesystem.sandbox.read`, `filesystem.picker`, `clipboard.write` or `process.inspect`;
- unknown methods fail closed when no policy exists;
- capability owner IDs must match the authenticated execution context;
- normal filesystem operations cannot escape the SWIR data sandbox;
- external resources are available only after explicit Windows picker actions;
- capability grants are random 192-bit tokens, session-bound, owner-bound, expiring and revocable;
- protected text reads are capped at 2 MiB;
- process spawning/termination, native network control and updater apply remain denied;
- existing SWIR package permissions and Secure Install Pipeline remain separate gates.

Capability grants and execution contexts are in-memory. Restarting the host invalidates both.

## Runtime security diagnostics

SWIR Runtime 1.2 exposes read-only diagnostics without exposing the execution token:

```js
const context = await SwirRuntime.security.context();
const canRead = await SwirRuntime.security.can('filesystem.sandbox.read');
const authenticated = await SwirRuntime.security.isAuthenticated();
```

`context.tokenExposed` is always `false` in the native broker descriptor.

## Important trust boundary

Preview 0.3 authenticates the **shell execution context**, but it does not yet authenticate third-party apps separately. All current UI is still hosted inside one WebView2 document. Therefore app code must not receive independent native permissions until SWIR introduces isolated app execution realms (separate WebView/frame/process boundary) and the host issues a distinct context token to each verified package.

Because of this, `SwirRuntime.filesystem.forApp('another.app')` will now fail native capability operations with `EXECUTION_IDENTITY_MISMATCH` while the active native context belongs to `swir.system.shell`. This is deliberate fail-closed behavior, not a regression.

## Implemented native surfaces

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
security.contextInfo
security.can
```

Present but denied by policy:

```text
processes.spawn
processes.kill
```

## Authorization flow

```text
SWIR RUNTIME CALL
   -> injected bridge closure
   -> execution token + request
   -> trusted origin check
   -> session context lookup
   -> method permission policy
   -> requested owner == authenticated appId
   -> capability validation (when required)
   -> native operation
```

## Next host milestone

1. isolated app execution realm / frame-to-package identity;
2. issue separate execution contexts from installed package manifests and granted permissions;
3. map Secure Install Pipeline grants into Desktop Permission Broker policies;
4. directory capability operations with scoped enumeration;
5. native tray integration;
6. updater staging/rollback;
7. process/service broker with strict executable allowlists;
8. self-contained Windows publish package and smoke-test CI.
