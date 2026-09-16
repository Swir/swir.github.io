# SWIR Desktop Package Payload 1.0

`swir.desktop-package-payload/1.0` defines the native Desktop Edition payload deployment core for `.swirapp` bundles.

## Security boundary

The payload installer is not itself a trust authority. It receives an expected SHA-256 only after `DesktopPackageBridge` has applied the configured native trust policy. The installer independently recomputes the bundle digest and fails closed when the archive bytes differ from the authorized digest.

Desktop Package Core now supports two cryptographic trust layers above the installer:

- signed official catalog authorization (`swir.catalog-signature/1.0`), and
- direct package signatures (`swir.desktop-package-signature/1.0`) verified with provisioned Ed25519 package roots.

If both catalog and package roots are provisioned, both checks are required. The package signature must bind the same package identity, version and SHA-256 that the trusted catalog authorization selects. Production private signing keys remain outside the client and repository.

The installer never executes payload code while inspecting or deploying a package.

## Bundle requirements

A `.swirapp` is a ZIP-compatible archive containing `swir-package.json` at its root. The manifest must use `swir.app/1.0` and provide the required Package 1.0 identity/runtime fields used by Desktop deployment: package identity, version, name, author, type and entry.

Native extraction rejects absolute/rooted paths, `..` traversal, duplicate case-insensitive paths, symbolic links, oversized entries and archives whose expanded size exceeds the configured ceiling.

Before promotion to `Current`, the staged package is health-checked without executing application code. The declared entry must be a safe relative path, must remain inside the staging root, must exist as a regular file and must not be a reparse point. Invalid or incomplete manifests and missing/unsafe entries fail before any installed slot is replaced.

## Package-level Ed25519 signatures

`DesktopPackageSignatureVerifier` validates the detached `swir.desktop-package-signature/1.0` envelope documented in `SWIR-DESKTOP-PACKAGE-SIGNATURE-1.0.md`.

The verifier:

1. parses and validates the signature envelope,
2. binds `packageId` and `version` to the selected package manifest,
3. recomputes SHA-256 over the exact `.swirapp` bytes,
4. checks the trusted key scope (`*`, `package:*` or `package:<id>`),
5. verifies the Ed25519 signature using a provisioned raw public key,
6. fails closed before package mutation on any mismatch.

Native package public roots are provisioned through `package-trust-roots.json` or `SWIR_PACKAGE_TRUST_ROOTS`. The source template intentionally contains no production key material.

## Deployment slots

Per package, Desktop Edition maintains:

```text
Packages/Installed/<packageId>/
  Current/
  Previous/
```

A new payload is fully extracted and validated in a managed staging directory before it can affect `Current`. Updates rotate the old `Current` into `Previous`; if promotion of the incoming payload fails, the previous slot is restored. Successful deployments persist `.swir-deployment.json` containing the installed version, verified bundle SHA-256, package type and verified entry path.

Rollback swaps `Current` and `Previous`, allowing the last known payload to be restored without downloading it again.

### Startup recovery

The installer performs bounded recovery whenever the Desktop package service is created. It removes orphaned staging and `.incoming-*` directories left by an interrupted deployment. If a crash happened after `Current` was moved aside but before a replacement reached `Current`, an existing `Previous` slot is promoted back to `Current`. Interrupted `.rollback-*` swaps are also reconciled conservatively so a known package slot is not silently discarded.

Recovery never downloads replacement files and never invents package metadata; it only reconciles already-local managed slots.

## Capability-bound Package bridge

`DesktopPackageBridge` places the installer behind an owner-bound file capability instead of accepting an arbitrary filesystem path from web content. Package mutation is restricted to the trusted `swir.system.shell` owner, and the file capability is consumed after an install attempt, including trust or integrity failures.

The native trust boundary is:

```text
trusted shell / Store
       |
       +--> signed catalog authorization (when provisioned)
       +--> Ed25519 package signature (when provisioned)
       +--> owner-bound file capability or trusted release artifact
       |
       v
DesktopPackageBridge
       |
       +--> dependency preflight
       +--> package identity/version binding
       +--> exact bundle SHA-256 binding
       +--> trusted package key/scope verification
       v
DesktopAppPackageInstaller
       |
       +--> independent SHA-256 verification
       +--> archive hardening
       +--> manifest validation
       +--> staged entry health verification
       +--> Current / Previous promotion
       +--> startup crash recovery
       v
verified desktop payload
```

When only preview trust is configured, legacy SHA authorization remains available for controlled development. Provisioning catalog roots disables arbitrary SHA trust in favor of signed catalog authorization. Provisioning package roots disables arbitrary SHA trust in favor of package signatures. If both are provisioned, the bridge advertises and enforces `SIGNED_CATALOG_AND_PACKAGE_SIGNATURE_REQUIRED`.

## Current integration state

`DesktopAppPackageInstaller`, `DesktopPackageBridge`, `DesktopCatalogTrustVerifier` and `DesktopPackageSignatureVerifier` are compiled into the shipping Windows Desktop Host. Windows contract workflows cover hardened install/update/rollback, hash/traversal/duplicate-path checks, capability ownership, dependency preflight, catalog authorization, package Ed25519 signatures, identity binding, key scope, invalid signatures and trust-root fail-closed policy.

Staged package health validation verifies required manifest metadata and the declared entry before promotion, while restart-oriented tests exercise recovery of interrupted managed slots. The trusted shell/runtime package surface already crosses the native bridge; production release provisioning still needs real public package signing roots and externally managed private signing keys.
