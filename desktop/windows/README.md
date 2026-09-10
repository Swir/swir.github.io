# SWIR OS Desktop Host — Windows Preview 0.1

This is the first runnable native-host skeleton for SWIR OS Desktop Edition.

## What it does

- hosts the existing SWIR shell in Microsoft WebView2;
- maps the repository root to the isolated `https://swir.local/` virtual origin;
- injects `window.SWIR_NATIVE_HOST` before application scripts run;
- implements the existing `swir.runtime/1.0` boundary;
- provides native clipboard access;
- provides a sandboxed native filesystem under `%LOCALAPPDATA%\SWIR\DesktopHost\Data`;
- allows explicit user-driven external file/folder selection through Windows dialogs;
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
- process spawning and termination are disabled;
- the JavaScript bridge uses an allowlisted dispatcher rather than arbitrary native invocation;
- existing SWIR package permissions and Secure Install Pipeline remain separate gates.

The picker result currently includes a native path for future tokenization work. Applications should not rely on that path as a stable capability. A later Desktop Host milestone should replace raw paths with revocable capability tokens.

## Implemented native surfaces

```text
filesystem.list
filesystem.get
filesystem.save
filesystem.remove
filesystem.pickFile
filesystem.pickDirectory
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

## Next host milestone

1. capability-token filesystem broker;
2. native permission broker mapped to SWIR package grants;
3. tray integration;
4. native updater staging/rollback;
5. process/service broker with strict executable allowlists;
6. build/publish scripts producing a self-contained Windows package.
