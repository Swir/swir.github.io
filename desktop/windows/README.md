# SWIR OS Desktop Host — Windows Preview 0.3.1

This is the native-host line for SWIR OS Desktop Edition.

## What it does

- hosts the existing SWIR shell in Microsoft WebView2;
- maps the repository root to the isolated `https://swir.local/` virtual origin;
- injects `window.SWIR_NATIVE_HOST` before application scripts run;
- implements the stable `swir.runtime/1.0` boundary;
- adds an in-memory Desktop Permission Broker with authenticated host-session execution contexts;
- loads `app-policy.json` as a fail-closed Desktop package execution policy registry;
- validates package IDs, local entry paths and declared permission sets at host startup;
- can derive native permissions only from permissions declared by the trusted package policy;
- rejects attempted permission escalation with `PACKAGE_PERMISSION_ESCALATION`;
- requires a non-exported 256-bit execution token on every native bridge request;
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

## Desktop package policy registry

`app-policy.json` mirrors the security-relevant package identity used by the official `swir-packages.js` catalog: `packageId`, `entry` and declared package permissions. It is intentionally small and reviewable.

`ExecutionPolicyCatalog` validates it on startup. `PermissionBroker.RegisterApplicationContext(...)` can create a future package execution context only after the package exists in that registry and the requested grants are a subset of the package's declared permissions. The method is host-internal and is **not exposed to the current shell bridge** yet.

The CI workflow runs `node validate-policy.mjs` and fails if the Desktop policy registry drifts from the official SWIR package catalog.

Current package-to-native mapping is deliberately conservative:

- `files.read` -> `filesystem.picker`, `filesystem.capability.read`;
- `files.write` -> `filesystem.sandbox.read`, `filesystem.sandbox.write`;
- `clipboard` -> `clipboard.read`, `clipboard.write`;
- package permissions without a safe native implementation currently grant no native capability.

## Security model

Preview 0.3.1 follows least privilege:

- native calls require a valid execution context token tied to the current host session;
- the token is captured inside the injected bridge closure and is not exported through `window.SWIR_NATIVE_HOST`;
- every method is mapped to a named native permission;
- unknown methods fail closed when no policy exists;
- package execution contexts must come from the trusted policy registry;
- requested package grants must be a subset of the declared package permissions;
- capability owner IDs must match the authenticated execution context;
- normal filesystem operations cannot escape the SWIR data sandbox;
- external resources are available only after explicit Windows picker actions;
- capability grants are random 192-bit tokens, session-bound, owner-bound, expiring and revocable;
- protected text reads are capped at 2 MiB;
- process spawning/termination, native network control and updater apply remain denied.

Capability grants and execution contexts are in-memory. Restarting the host invalidates both.

## Runtime security diagnostics

SWIR Runtime 1.2.1 exposes read-only diagnostics without exposing execution tokens:

```js
const context = await SwirRuntime.security.context();
const canRead = await SwirRuntime.security.can('filesystem.sandbox.read');
const policy = await SwirRuntime.security.policyCatalog();
const authenticated = await SwirRuntime.security.isAuthenticated();
```

`context.tokenExposed` is always `false` in the native broker descriptor.

## Important trust boundary

Preview 0.3.1 authenticates the **shell execution context**, but it does not yet authenticate third-party apps separately. Current UI still shares one WebView2 document. Therefore `RegisterApplicationContext` remains host-internal and application execution tokens are not issued to page code until SWIR has isolated app execution realms.

`SwirRuntime.filesystem.forApp('another.app')` therefore continues to fail native capability operations with `EXECUTION_IDENTITY_MISMATCH` while the active native context belongs to `swir.system.shell`. This is deliberate fail-closed behavior.

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
security.policyCatalog
```

Present but denied by policy:

```text
processes.spawn
processes.kill
```

## Authorization direction

```text
VERIFIED PACKAGE
   -> app-policy.json identity + declared permissions
   -> installed permission grants (next isolation milestone)
   -> package grant subset validation
   -> native permission projection
   -> isolated execution context (not exposed yet)
   -> runtime call
   -> native method policy
   -> capability validation
   -> native operation
```

## Next host milestone

1. isolated app execution realm / frame-to-package identity;
2. bind installed Secure Install Pipeline grants to `RegisterApplicationContext`;
3. issue each isolated package its own non-exported execution context;
4. directory capability operations with scoped enumeration;
5. native tray integration;
6. updater staging/rollback;
7. process/service broker with strict executable allowlists;
8. self-contained Windows publish package and smoke-test CI.
