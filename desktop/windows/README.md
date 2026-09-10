# SWIR OS Desktop Host — Windows Preview 0.4

This is the native-host line for SWIR OS Desktop Edition.

## What it does

- hosts the existing SWIR shell in Microsoft WebView2;
- maps the shell to the isolated `https://swir.local/` virtual origin;
- maps each trusted installable package to its own virtual HTTPS origin (`https://app-<package>.swir.local/`);
- injects `window.SWIR_NATIVE_HOST` only into the top-level shell document, never into package frames;
- accepts shell bridge messages only from the exact `https://swir.local/index.html` source;
- implements the stable `swir.runtime/1.0` boundary;
- adds an in-memory Desktop Permission Broker with authenticated host-session execution contexts;
- loads `app-policy.json` as a fail-closed Desktop package execution policy registry;
- validates package IDs, local entry paths and declared permission sets at host startup;
- derives native permissions only from permissions declared by the trusted package policy;
- rejects attempted permission escalation with `PACKAGE_PERMISSION_ESCALATION`;
- requires a non-exported 256-bit execution token on every native shell bridge request;
- rejects owner/app identity mismatches before capability resolution;
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

The host walks upward from its build directory until it finds the repository `index.html`, then serves the checkout through WebView2 virtual hosts.

## App Execution Isolation 0.4

`AppIsolationRegistry` derives one deterministic origin per trusted `packageId` from `app-policy.json`. The host maps those origins to the repository root with `DenyCors`, while `swir-apps.js` rewrites only installed package iframe URLs when Desktop Host is active.

Example:

```text
swir.code + ./swir-code.html
-> https://app-swir-code.swir.local/swir-code.html
```

This means installable package frames no longer share the shell origin. They cannot read `parent.SWIR_NATIVE_HOST`, shell localStorage, shell DOM, or the non-exported shell execution-token closure through same-origin JavaScript.

The native bootstrap has an additional top-level guard and refuses to create `SWIR_NATIVE_HOST` unless the document is exactly the top-level `https://swir.local/index.html` shell. Package origins currently receive **no direct native bridge**. That is intentional: per-package native contexts will be enabled only after grants from Secure Install Pipeline can be bound to host-created execution contexts.

`SwirRuntime.security.appUrl(packageId, entry)` and `isolationInfo()` expose read-only routing/diagnostic contracts. The host independently verifies that the requested package entry equals the trusted policy entry before returning an isolated URL.

## Desktop package policy registry

`app-policy.json` mirrors the security-relevant package identity used by the official `swir-packages.js` catalog: `packageId`, `entry` and declared package permissions. `ExecutionPolicyCatalog` validates it on startup, while CI runs `validate-policy.mjs` to block catalog drift.

Current package-to-native mapping remains conservative:

- `files.read` -> `filesystem.picker`, `filesystem.capability.read`;
- `files.write` -> `filesystem.sandbox.read`, `filesystem.sandbox.write`;
- `clipboard` -> `clipboard.read`, `clipboard.write`;
- package permissions without a safe native implementation currently grant no native capability.

## Security model

Preview 0.4 follows least privilege:

- native shell calls require a valid execution-context token tied to the current host session;
- the shell token is captured inside the injected bridge closure and is not exported;
- the bridge is injected only into the exact top-level shell document;
- installable package frames use separate origins and receive no shell/native bridge;
- every native method is mapped to a named permission;
- unknown methods fail closed;
- package execution contexts must come from the trusted policy registry;
- requested package grants must be a subset of declared package permissions;
- capability owner IDs must match the authenticated execution context;
- normal filesystem operations cannot escape the SWIR data sandbox;
- external resources are available only after explicit Windows picker actions;
- capability grants are random 192-bit tokens, session-bound, owner-bound, expiring and revocable;
- protected text reads are capped at 2 MiB;
- process spawning/termination, native network control and updater apply remain denied.

Capability grants and execution contexts are in-memory. Restarting the host invalidates both.

## Runtime security diagnostics

SWIR Runtime 1.3.0 exposes read-only diagnostics:

```js
const context = await SwirRuntime.security.context();
const canRead = await SwirRuntime.security.can('filesystem.sandbox.read');
const policy = await SwirRuntime.security.policyCatalog();
const isolation = await SwirRuntime.security.isolationInfo();
const url = await SwirRuntime.security.appUrl('swir.code', './swir-code.html');
const authenticated = await SwirRuntime.security.isAuthenticated();
```

## Important trust boundary

Preview 0.4 isolates installed package **web execution origins**, but it does not yet expose an authenticated native bridge inside those package origins. `PermissionBroker.RegisterApplicationContext(...)` remains host-internal. This avoids giving page-controlled code a package identity before the host can bind it to installed permission grants.

Core system iframe applications are still shell-trusted components and remain on `swir.local`; installable catalog packages are the first class moved behind the package-origin boundary.

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
security.appUrl
security.isolationInfo
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
   -> dedicated package HTTPS origin               [implemented]
   -> installed permission grants                  [next]
   -> package grant subset validation
   -> host-created package execution context       [next]
   -> package-scoped native bridge                 [next]
   -> native method policy
   -> capability validation
   -> native operation
```

## Next host milestone

1. bind Secure Install Pipeline grants to Desktop package contexts;
2. inject a package-scoped bridge only into the matching isolated origin;
3. revoke package contexts and capabilities when an app closes/uninstalls/session changes;
4. directory capability operations with scoped enumeration;
5. native tray integration;
6. updater staging/rollback;
7. process/service broker with strict executable allowlists;
8. self-contained Windows publish package and smoke-test CI.
