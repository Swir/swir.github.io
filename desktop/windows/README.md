# SWIR OS Desktop Host — Windows Preview 0.5.0

This is the native-host line for SWIR OS Desktop Edition.

## Current state

Preview 0.5.0 keeps the `swir.runtime/1.0` boundary, WebView2 host, capability broker, Desktop package policy registry and package execution-context broker, and now enables isolated package routing for the five official installable packages after their migration to the portable SWIR App Bridge.

The host now:

- hosts the SWIR shell at `https://swir.local/index.html`;
- maps every trusted installable package to a deterministic dedicated origin;
- enables package isolation routing only for package entries validated by the trusted policy registry;
- loads `app-policy.json` fail-closed and validates it against the official package catalog in CI;
- keeps shell and package execution tokens host-side;
- accepts native shell calls only from the exact shell document;
- resolves package native identity only from exact trusted package origin + exact entry path;
- rejects non-default ports and user-info on trusted shell/package source checks;
- creates package execution contexts from installed permission grants and validates them against `app-policy.json`;
- revokes package capability tokens when package contexts disappear or grants change;
- keeps process spawn/kill, native network control and updater apply denied;
- keeps external filesystem access behind expiring owner-bound capability tokens.

## App isolation routing

The five official installable applications have been migrated away from direct `parent.SwirPlatform` / `parent.SwirAppSDK` dependencies and communicate with the shell through `swir-app-bridge.js` + `swir-app-bridge-host.js`.

Preview 0.5.0 therefore advertises:

```text
features.packageContextBroker = true
features.appIsolationRouting = true
features.appIsolationState = APP_BRIDGE_VERIFIED
```

`swir-apps.js` routes installed iframe packages to origins such as:

```text
https://app-swir-code.swir.local/swir-code.html
https://app-swir-chat.swir.local/swir-chat.html
```

Web Edition remains on same-origin relative application URLs.

## Trust boundary

Isolation depends on multiple checks rather than hostname alone:

```text
trusted package catalog
  -> app-policy.json
  -> deterministic isolated origin
  -> exact package entry path
  -> managed iframe source
  -> App Bridge packageId check
  -> granted package permission
```

`AppIsolationRegistry.TryResolveEntrySource()` requires HTTPS, the exact registered virtual host, the exact trusted package entry path, no user-info and the default HTTPS port.

The package-side App Bridge never receives native execution tokens. Package-native messages are attributed by the host from their exact source origin and entry path, and the corresponding execution token is resolved internally.

## Package execution-context synchronization

`SwirRuntime.security.syncInstalledContexts()` reads installed package records and granted permissions from `SwirPlatform`, builds a minimal snapshot and sends it to the native host.

The host validates the complete snapshot before mutation:

```text
installed package
  -> granted package permissions
  -> app-policy.json declared permissions
  -> ResolveNativePermissions()
  -> host-owned package execution context
```

Package tokens are host-side only. Context synchronization is debounced on package and permission changes.

## Native permission projection

Current conservative mapping:

- `files.read` -> `filesystem.picker`, `filesystem.capability.read`;
- `files.write` -> `filesystem.sandbox.read`, `filesystem.sandbox.write`;
- `clipboard` -> `clipboard.read`, `clipboard.write`;
- other package permissions currently project to no native capability.

Every package context also receives read-only `runtime.inspect`. Unknown native methods remain fail-closed.

## Runtime diagnostics

SWIR Runtime exposes:

```js
await SwirRuntime.security.context();
await SwirRuntime.security.can('filesystem.sandbox.read');
await SwirRuntime.security.policyCatalog();
await SwirRuntime.security.isolationInfo();
await SwirRuntime.security.packageContexts();
await SwirRuntime.security.syncInstalledContexts();
```

## Verification status

Static App Bridge readiness and policy validation exist in CI, and the Windows host is built on GitHub Actions. Enabling routing is an architectural milestone, not a claim that every application flow has already been exercised in a manually launched Windows `.exe`.

Until runtime E2E checks cover all five isolated origins, failures should be treated as Preview regressions and isolation should remain fail-closed rather than bypassing origin or permission checks.

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

1. add automated isolated-origin smoke tests for all five official packages;
2. add package-scoped native App Data roots instead of the shared preview sandbox;
3. expose directory capability enumeration only through per-package grants;
4. add a limited native tray adapter;
5. build staged update download/verify/apply contracts without bypassing signature or permission checks;
6. publish a repeatable self-contained Windows Desktop preview artifact once E2E checks are green.
