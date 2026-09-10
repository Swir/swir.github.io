# SWIR OS Desktop Host — Windows Preview 0.4.1

This is the native-host line for SWIR OS Desktop Edition.

## Current state

Preview 0.4.1 keeps the `swir.runtime/1.0` boundary, WebView2 host, capability broker, Desktop package policy registry and package-origin registry from 0.4, but adds a host-owned package execution-context synchronization layer.

The host now:

- hosts the current SWIR shell at `https://swir.local/index.html`;
- keeps deterministic isolated origins reserved for trusted installable packages;
- loads `app-policy.json` fail-closed and validates it against the official package catalog in CI;
- keeps the shell execution token in the injected bridge closure;
- accepts native shell calls only from the exact shell document;
- can create package execution contexts from the actual installed permission grants supplied by the trusted shell;
- validates every synchronized package grant against `app-policy.json` before changing active contexts;
- never returns package execution tokens to JavaScript;
- revokes package capability tokens when a package context disappears or its grants change;
- rejects duplicate package-context requests and permission escalation;
- keeps process spawn/kill, native network control and updater apply denied;
- keeps external filesystem access behind expiring, owner-bound capability tokens.

## Regression fix: isolation routing gate

Preview 0.4 mapped installed package iframe URLs directly to isolated origins. During verification we found that current package applications still use same-origin calls such as `parent.SwirPlatform` and `parent.SwirAppSDK`. Moving those pages to another origin before a portable App API Bridge exists breaks those calls because of browser same-origin policy.

0.4.1 therefore keeps the isolation registry and reserved package origins, but advertises:

```text
features.packageContextBroker = true
features.appIsolationRouting = false
features.appIsolationState = APP_API_BRIDGE_PENDING
```

`swir-apps.js` only switches an installed package to its dedicated origin when `appIsolationRouting === true`. Until the portable App API Bridge is implemented, packages continue using their compatible shell-origin route. This is an intentional stability patch, not removal of the isolation design.

## Package execution-context synchronization

`SwirRuntime.security.syncInstalledContexts()` reads the installed package records and granted permissions from `SwirPlatform`, builds a minimal package/grant snapshot, and sends that snapshot to the native host.

The host validates the complete snapshot before mutation:

```text
installed package
  -> granted package permissions
  -> app-policy.json declared permissions
  -> ResolveNativePermissions()
  -> host-owned package execution context
```

The shell has the dedicated `runtime.context.manage` native capability. Package contexts do not receive it.

Package tokens are host-side only. When a future isolated package page sends a native message, the host will derive package identity from the exact trusted origin + entry path and resolve its execution token internally. Page-provided execution tokens are not trusted for package sources.

Synchronization is debounced on `swir:package-change` and `swir:permission-change`, so a multi-permission install produces the final complete grant snapshot rather than a partial intermediate one.

## Source validation

`AppIsolationRegistry.TryResolveEntrySource()` now requires both:

- the exact trusted package virtual host; and
- the exact trusted package entry path.

A different page hosted under the same virtual hostname is not enough to obtain package identity.

## Native permission projection

Current conservative mapping:

- `files.read` -> `filesystem.picker`, `filesystem.capability.read`;
- `files.write` -> `filesystem.sandbox.read`, `filesystem.sandbox.write`;
- `clipboard` -> `clipboard.read`, `clipboard.write`;
- other package permissions currently project to no native capability.

Every package context also receives read-only `runtime.inspect`. Unknown native methods remain fail-closed.

## Runtime diagnostics

SWIR Runtime 1.3.1 exposes:

```js
await SwirRuntime.security.context();
await SwirRuntime.security.can('filesystem.sandbox.read');
await SwirRuntime.security.policyCatalog();
await SwirRuntime.security.isolationInfo();
await SwirRuntime.security.packageContexts();
await SwirRuntime.security.syncInstalledContexts();
```

The native host exposes `security.syncPackageContexts` only to the trusted shell context. `security.packageContexts` exposes metadata but never execution tokens.

## Important trust boundary

The package context broker is now implemented, but package-native execution remains intentionally disabled until the package App API Bridge is ready. This prevents a security architecture milestone from breaking the currently working application model.

Before `appIsolationRouting` can be enabled, package applications need a portable local API that replaces direct `parent.*` access. Native package filesystem storage also needs per-package App Data namespaces so `files.write` cannot become a shared sandbox between packages.

## Requirements

- Windows 10/11
- .NET 8 SDK
- Microsoft Edge WebView2 Runtime

## Build

```powershell
cd desktop\windows
dotnet restore
dotnet build -c Release
```

or:

```powershell
.\build.ps1
```

## Next host milestone

1. implement `swir-app-bridge.js` as a portable package API independent of `parent.*`;
2. migrate the five official installable packages to that bridge;
3. add package-scoped App Data roots in the native filesystem adapter;
4. enable package native bootstrap only for exact trusted package entry sources;
5. switch `appIsolationRouting` to true after CI/smoke verification;
6. then add directory capability enumeration, native tray and staged updater support.
