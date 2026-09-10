# SWIR OS Desktop Host — Windows Preview 0.2

This is the first native-host line for SWIR OS Desktop Edition.

## What it does

- hosts the existing SWIR shell in Microsoft WebView2;
- maps the repository root to the isolated `https://swir.local/` virtual origin;
- injects `window.SWIR_NATIVE_HOST` before application scripts run;
- implements the stable `swir.runtime/1.0` boundary;
- provides native clipboard access;
- provides a sandboxed native filesystem under `%LOCALAPPDATA%\SWIR\DesktopHost\Data`;
- allows explicit user-driven external file/folder selection through Windows dialogs;
- converts external file/folder selections into revocable capability tokens instead of returning raw OS paths;
- exposes host-process diagnostics;
- rejects native process spawn/kill until a permission broker exists.

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

The host walks upward from its build directory until it finds the repository `index.html`, then serves the current checkout through the WebView2 virtual host.

## Security model

This preview intentionally follows least privilege:

- normal filesystem operations cannot escape the SWIR data sandbox;
- path traversal and nested arbitrary paths are rejected;
- external files/directories are available only after a Windows picker action;
- picker results never expose `nativePath` to JavaScript;
- picker grants use random 192-bit capability tokens;
- capability tokens expire after 30 minutes and can be revoked earlier;
- token kind is validated before protected operations;
- process spawning and termination remain disabled;
- the JavaScript bridge uses an allowlisted dispatcher rather than arbitrary native invocation;
- existing SWIR package permissions and Secure Install Pipeline remain separate gates.

Capability grants are intentionally in-memory in Preview 0.2, so restarting the host revokes them all automatically.

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
filesystem.pruneCapabilities
clipboard.readText
clipboard.writeText
clipboard.clear
processes.list
processes.open
```

Present but denied until a permission broker is implemented:

```text
processes.spawn
processes.kill
```

Surfaces not yet supplied by the host continue to use the Web adapter where that is safe, or return `RUNTIME_UNSUPPORTED` through `SwirRuntime`.

## Capability lifecycle

```text
USER PICKER
   -> capability token
   -> validated native operation
   -> revoke / expiry / host restart
```

A token is an opaque authorization reference, not a path. Applications must not attempt to derive Windows paths from it.

## Next host milestone

1. native permission broker mapped to SWIR package grants;
2. bind capability tokens to requesting app/package identity;
3. directory capability operations with strict scoped enumeration;
4. tray integration;
5. native updater staging/rollback;
6. process/service broker with strict executable allowlists;
7. build/publish scripts producing a self-contained Windows package.
