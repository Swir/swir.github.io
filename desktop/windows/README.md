# SWIR OS Desktop Host — Windows Preview 0.2.1

This is the first native-host line for SWIR OS Desktop Edition.

## What it does

- hosts the existing SWIR shell in Microsoft WebView2;
- maps the repository root to the isolated `https://swir.local/` virtual origin;
- injects `window.SWIR_NATIVE_HOST` before application scripts run;
- implements the stable `swir.runtime/1.0` boundary;
- provides native clipboard access;
- provides a sandboxed native filesystem under `%LOCALAPPDATA%\SWIR\DesktopHost\Data`;
- allows explicit user-driven external file/folder selection through Windows dialogs;
- converts external selections into revocable capability tokens instead of returning raw OS paths;
- binds every external capability to the current host session and an application identity;
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

Preview 0.2.1 follows least privilege:

- normal filesystem operations cannot escape the SWIR data sandbox;
- path traversal and nested arbitrary paths are rejected;
- external files/directories are available only after a Windows picker action;
- picker results never expose `nativePath` to JavaScript;
- picker grants use random 192-bit capability tokens;
- grants are bound to a host session ID and owner app ID;
- a token cannot be used through another owner identity;
- grants expire after 30 minutes and can be revoked individually or per owner;
- protected reads validate token, session, owner, kind, expiry and resource existence;
- text reads through external capabilities are capped at 2 MiB in this preview;
- process spawning and termination remain disabled;
- the bridge exposes an allowlisted dispatcher rather than arbitrary native invocation;
- existing SWIR package permissions and Secure Install Pipeline remain separate gates.

Capability grants remain in-memory, so restarting the host revokes all of them automatically.

### Important trust boundary

`ownerAppId` binding is isolation groundwork, not yet a complete permission boundary. The current WebView shell is still same-origin JavaScript, so the native host cannot yet cryptographically prove which app frame originated a claimed app ID. For that reason Preview 0.2.1 does **not** unlock process spawn, arbitrary native filesystem writes, native network control or updater apply.

A later Desktop Permission Broker must authenticate app execution context and validate the package permission grant before privileged operations are enabled.

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
```

Present but denied until a permission broker is implemented:

```text
processes.spawn
processes.kill
```

## App-scoped runtime use

Portable application code can obtain a scoped facade without talking directly to the C# bridge:

```js
const fs = SwirRuntime.filesystem.forApp('swir.example.notes');
const picked = await fs.pickFile();
const text = picked ? await fs.readCapabilityText(picked.token) : null;
await fs.revokeAllCapabilities();
```

Existing shell-level Runtime calls remain backward compatible and use `swir.system.shell` as their owner identity.

## Capability lifecycle

```text
USER PICKER
   -> random capability token
   -> bind { host session + owner app }
   -> validate { token + session + owner + kind + expiry }
   -> native operation
   -> revoke / expiry / host restart
```

A token is an opaque authorization reference, not a path.

## Next host milestone

1. authenticated Desktop Permission Broker mapped to installed package grants;
2. trusted app execution context / frame-to-package identity;
3. directory capability operations with strict scoped enumeration;
4. native tray integration;
5. native updater staging/rollback;
6. process/service broker with strict executable allowlists;
7. self-contained Windows publish package and CI build verification.
