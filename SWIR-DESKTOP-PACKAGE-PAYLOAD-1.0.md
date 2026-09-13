# SWIR Desktop Package Payload 1.0

`swir.desktop-package-payload/1.0` defines the native Desktop Edition payload deployment core for `.swirapp` bundles.

## Security boundary

The payload installer is not a trust authority. A caller must supply the SHA-256 value obtained from already trusted package metadata. The installer fails closed when the archive hash differs. Package signature/catalog trust remains a separate Package Core responsibility.

The installer never executes payload code while inspecting or deploying a package.

## Bundle requirements

A `.swirapp` is a ZIP-compatible archive containing `swir-package.json` at its root. The manifest must use `swir.app/1.0` and provide a valid package identity and version.

Native extraction rejects absolute/rooted paths, `..` traversal, duplicate case-insensitive paths, symbolic links, oversized entries and archives whose expanded size exceeds the configured ceiling.

## Deployment slots

Per package, Desktop Edition maintains:

```text
Packages/Installed/<packageId>/
  Current/
  Previous/
```

A new payload is fully extracted and validated in a managed staging directory before it can affect `Current`. Updates rotate the old `Current` into `Previous`; if promotion of the incoming payload fails, the previous slot is restored. Successful deployments persist `.swir-deployment.json` containing the installed version and verified bundle SHA-256.

Rollback swaps `Current` and `Previous`, allowing the last known payload to be restored without downloading it again.

## Current integration state

`DesktopAppPackageInstaller` is compiled into the shipping Windows Desktop Host and covered by a Windows contract workflow plus hardened install/update/rollback/hash/traversal/duplicate-path self-tests. The next integration step is exposing it only through a trusted-shell Package bridge, using an owner-bound file capability instead of accepting arbitrary filesystem paths from web content.

Production completion also requires the Package Core to bind the trusted catalog/signature result, expected SHA-256 and native payload transaction into one end-to-end install operation.