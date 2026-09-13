# SWIR Desktop Package Payload 1.0

`swir.desktop-package-payload/1.0` defines the native Desktop Edition payload deployment core for `.swirapp` bundles.

## Security boundary

The payload installer is not a trust authority. A caller must supply the SHA-256 value obtained from already trusted package metadata. The installer fails closed when the archive hash differs. Package signature/catalog trust remains a separate Package Core responsibility.

The installer never executes payload code while inspecting or deploying a package.

## Bundle requirements

A `.swirapp` is a ZIP-compatible archive containing `swir-package.json` at its root. The manifest must use `swir.app/1.0` and provide the required Package 1.0 identity/runtime fields used by Desktop deployment: package identity, version, name, author, type and entry.

Native extraction rejects absolute/rooted paths, `..` traversal, duplicate case-insensitive paths, symbolic links, oversized entries and archives whose expanded size exceeds the configured ceiling.

Before promotion to `Current`, the staged package is health-checked without executing application code. The declared entry must be a safe relative path, must remain inside the staging root, must exist as a regular file and must not be a reparse point. Invalid or incomplete manifests and missing/unsafe entries fail before any installed slot is replaced.

## Deployment slots

Per package, Desktop Edition maintains:

```text
Packages/Installed/<packageId>/
  Current/
  Previous/
```

A new payload is fully extracted and validated in a managed staging directory before it can affect `Current`. Updates rotate the old `Current` into `Previous`; if promotion of the incoming payload fails, the previous slot is restored. Successful deployments persist `.swir-deployment.json` containing the installed version, verified bundle SHA-256, package type and verified entry path.

Rollback swaps `Current` and `Previous`, allowing the last known payload to be restored without downloading it again.

## Capability-bound Package bridge

`DesktopPackageBridge` places the installer behind an owner-bound file capability instead of accepting an arbitrary filesystem path from web content. Package mutation is restricted to the trusted `swir.system.shell` owner, and the file capability is consumed after an install attempt, including integrity failures.

This creates the intended native boundary:

```text
trusted shell / Store
       |
       v
owner-bound file capability
       |
       v
DesktopPackageBridge
       |
       +--> expected trusted SHA-256
       +--> capability ownership check
       v
DesktopAppPackageInstaller
       |
       +--> archive hardening
       +--> manifest validation
       +--> staged entry health verification
       +--> Current / Previous promotion
       v
verified desktop payload
```

## Current integration state

`DesktopAppPackageInstaller` and `DesktopPackageBridge` are compiled into the shipping Windows Desktop Host and covered by Windows contract workflows plus hardened install/update/rollback/hash/traversal/duplicate-path/capability self-tests. Staged package health validation additionally verifies required manifest metadata and the declared entry before promotion.

The remaining shipping integration step is exposing the Package bridge through the trusted `SwirRuntime` native `packages` surface and proving the full shell/runtime E2E. Production completion also requires Package Core to bind a verified catalog/signature decision, expected SHA-256 and native payload transaction into one end-to-end install operation.