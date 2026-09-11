# SWIR OS Desktop Host — Windows Preview 0.5.1

This is the native-host line for SWIR OS Desktop Edition.

## Current state

Preview 0.5.1 keeps the `swir.runtime/1.0` boundary, WebView2 host, capability broker, Desktop package policy registry and package execution-context broker. It enables isolated routing for the five official installable packages, provides package-scoped native App Data, and now contains a signed update trust/download/staging/handoff pipeline with crash-safe transaction journaling, candidate preparation, rollback-safe deployment slots and a guarded post-activation health-check contract.

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
- downloads only a previously verified update target with redirects, cookies and ambient credentials disabled;
- stages verified update streams below `%LOCALAPPDATA%\SWIR\Updates\Staging` using streaming SHA-256, signed-size enforcement, temporary files and atomic promotion;
- prepares a non-executing handoff plan and re-verifies the staged package before an apply transaction can begin;
- journals update transactions through prepared/applying/awaiting-health-check/commit or rollback states with stale-state protection and recovery discovery;
- prepares verified candidate payloads from the Desktop package manifest with traversal, symlink, duplicate-name, file-count, expanded-size and per-file SHA-256 enforcement;
- maintains rollback-safe `Current`, `Previous` and transaction-scoped `Candidate` deployment slots with conservative crash recovery;
- issues a short-lived 256-bit health challenge after activation, stores only its SHA-256 digest, requires the exact target version for commit, and moves expired health checks to `rollback-pending`;
- immediately restores `Previous` if activation succeeds but the health challenge cannot be created;
- keeps automatic process launch/restart disabled while activation and recovery remain explicitly orchestrated by the standalone updater worker foundation;
- keeps process spawn/kill and unrestricted native network control denied to WebView applications;
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

## Signed update pipeline

`UpdateBroker` accepts only signed `swir.update-envelope/0.1` envelopes carrying `swir.desktop-update/0.1` payloads. Current signature algorithm is `RSA-PSS-SHA256`.

Before an update can be considered verified, the broker checks signature/key material, release channel, monotonic version upgrade, publication timestamp, canonical HTTPS package URL with explicit host allowlist, signed package size capped at 512 MiB and SHA-256 package digest.

The current pipeline is deliberately split into narrow trust boundaries:

```text
signed manifest
  -> UpdateBroker verification
  -> restricted UpdateDownloadClient
  -> UpdateStagingBroker streaming verification
  -> UpdateHandoffBroker re-verification + prepared handoff
  -> UpdateTransactionJournal crash-safe state machine
  -> UpdaterWorkerProtocol planning
  -> CandidatePackagePreparer verified extraction
  -> DeploymentSlotActivator Current/Previous swap
  -> UpdateActivationCoordinator guarded health issuance
  -> UpdateRecoveryCoordinator crash/timeout rollback
  -> future controlled candidate process launch
```

`UpdateDownloadClient` refuses redirects and ambient HTTP credentials. `UpdateStagingBroker` never promotes a partial package. `UpdateHandoffBroker` hashes the package again before creating a prepared handoff. `UpdateTransactionJournal` records recoverable state transitions atomically and rejects stale writers.

`CandidatePackagePreparer` extracts only manifested content into a transaction-specific candidate sandbox and re-verifies the payload before activation. `DeploymentSlotActivator` preserves the known-good deployment in `Previous`, promotes the candidate into `Current`, quarantines ambiguous/failed promoted content and prefers rollback over forward recovery after an interrupted swap.

`UpdateActivationCoordinator` couples successful slot activation with health challenge creation. A raw 256-bit token exists only in memory; persistent `health.json` stores its SHA-256 digest. If challenge issuance fails after the candidate has already been promoted, the coordinator immediately transitions to rollback and restores `Previous` rather than leaving an unconfirmable `Current` active.

`UpdateRecoveryCoordinator` reconciles `applying`, `awaiting-health-check` and `rollback-pending` transactions after startup. Missing/expired health metadata causes rollback, while a valid non-expired challenge remains pending for exact-version confirmation.

The update subsystem still deliberately does **not** launch the promoted candidate automatically, replace arbitrary binaries outside the controlled deployment slots, execute arbitrary installers, restart the host or bypass signature checks.

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

Windows CI checks Runtime/registry/App Bridge syntax and contracts, validates the Desktop package policy and all five isolated application entries, runs native App Data and Permission Broker self-tests, runs signed Update Broker/download/staging/handoff tests, runs transaction recovery/health-check tests, runs guarded activation/rollback tests, runs updater worker contract tests, builds the standalone updater worker and builds the Windows host.

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

1. add a controlled candidate launch contract that passes the health token only in-memory/process environment and never persists it in clear text;
2. prove launch failure and early process-exit paths restore `Previous` automatically before exposing `activate-and-restart` to Update Center;
3. wire startup recovery into the native host so incomplete transactions are reconciled before normal shell startup;
4. add release key-id/key rotation policy without accepting unsigned fallback keys;
5. expose read-only update transaction/staging diagnostics to Update Center;
6. add automated isolated-origin runtime smoke tests for all five official packages;
7. add a limited native tray adapter;
8. publish a repeatable self-contained Windows Desktop preview artifact once runtime E2E checks are green.
