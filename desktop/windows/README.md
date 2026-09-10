# SWIR OS Desktop Host — Windows Preview 0.5.1

This is the native-host line for SWIR OS Desktop Edition.

## Current state

Preview 0.5.1 keeps the `swir.runtime/1.0` boundary, WebView2 host, capability broker, Desktop package policy registry and package execution-context broker. It enables isolated routing for the five official installable packages, provides package-scoped native App Data, and now contains a signed update trust core plus a verification-only staging layer.

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
- stores native application data below `%LOCALAPPDATA%\SWIR\Apps\<packageId>\Data` with per-package isolation and quotas;
- verifies signed update envelopes using RSA-PSS/SHA-256 and strict HTTPS/host/version/package metadata policy;
- stages verified update streams below `%LOCALAPPDATA%\SWIR\Updates\Staging` using streaming SHA-256, signed-size enforcement, temporary files and atomic promotion;
- keeps updater apply/restart disabled until a rollback-safe apply contract exists;
- keeps process spawn/kill and unrestricted native network control denied;
- keeps external filesystem access behind expiring owner-bound capability tokens.

## App isolation routing

The five official installable applications communicate with the shell through `swir-app-bridge.js` + `swir-app-bridge-host.js` rather than direct `parent.SwirPlatform` / `parent.SwirAppSDK` access.

Preview 0.5.1 advertises:

```text
features.packageContextBroker = true
features.appIsolationRouting = true
features.appIsolationState = APP_BRIDGE_VERIFIED
features.nativeAppData = true
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
  -> host-owned execution context
```

The package-side App Bridge never receives native execution tokens. Package-native messages are attributed by the host from their exact source origin and entry path, and the corresponding execution token is resolved internally.

## Native App Data

`SwirRuntime.appData` is the portable application-storage contract. Web Edition keeps a namespaced browser fallback, while Desktop Edition routes storage through the native host.

Desktop storage uses:

```text
%LOCALAPPDATA%\SWIR\Apps\<packageId>\Data\
```

The broker enforces package identity, storage permissions, a 1 MiB maximum value, a 16 MiB package quota and a 512-item limit. Writes use temporary files and atomic replacement. Corrupt JSON and I/O failures are surfaced as controlled errors.

CI includes native App Data isolation tests and Permission Broker tests covering cross-package denial, permission downgrade, capability invalidation and package-context removal.

## Signed update trust core

`UpdateBroker` accepts only signed `swir.update-envelope/0.1` envelopes carrying `swir.desktop-update/0.1` payloads. Current signature algorithm is `RSA-PSS-SHA256`.

Before an update can be considered verified, the broker checks:

- signature and key material;
- release channel;
- monotonic version upgrade;
- publication timestamp;
- canonical HTTPS package URL and explicit host allowlist;
- signed package size, capped at 512 MiB;
- SHA-256 package digest.

`UpdateStagingBroker` then copies the package stream into a version-scoped staging directory while calculating SHA-256 incrementally. It never promotes a partial package. Only after exact signed size and digest match are both `package.bin` and `stage.json` atomically promoted from temporary files.

The staging layer deliberately does **not** execute installers, replace binaries, restart the host or bypass signature checks.

## Runtime diagnostics

SWIR Runtime exposes the portable security/App Data surfaces used by Desktop Edition, including:

```js
await SwirRuntime.security.context();
await SwirRuntime.security.can('filesystem.sandbox.read');
await SwirRuntime.security.policyCatalog();
await SwirRuntime.security.isolationInfo();
await SwirRuntime.security.packageContexts();
await SwirRuntime.security.syncInstalledContexts();
await SwirRuntime.appData.info(packageId);
```

## Verification status

Windows CI checks Runtime/registry/App Bridge syntax and contracts, validates the Desktop package policy and all five isolated application entries, runs native App Data and Permission Broker self-tests, runs signed Update Broker/staging self-tests, and builds the Windows host.

A green CI run verifies those automated paths. It is not yet a claim that every application workflow has been exercised manually in a packaged Windows `.exe`.

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

1. add an HTTPS update-download client that feeds only a previously verified manifest target into `UpdateStagingBroker`;
2. add release key-id/key rotation policy without accepting unsigned fallback keys;
3. expose read-only update/staging diagnostics to Update Center;
4. add rollback-safe apply planning and a separate privileged handoff instead of self-overwriting the running host;
5. add automated isolated-origin runtime smoke tests for all five official packages;
6. add a limited native tray adapter;
7. publish a repeatable self-contained Windows Desktop preview artifact once runtime E2E checks are green.
