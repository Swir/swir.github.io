# SWIR Install Pipeline 1.1

SWIR OS 1.7.10 introduced a portable installation pipeline intended to be shared by Web Edition, Desktop Edition and later System Edition. SWIR OS 1.7.11 hardens catalog identity matching and makes SWIR Store 2.3 use the pipeline for real install/remove actions.

## Flow

`INTEGRITY → TRUST → DEPENDENCIES → PERMISSIONS → INSTALL`

The pipeline is implemented in `swir-install-pipeline.js` and exposed through App SDK 1.6.

## Security model

1. **Integrity** validates manifest and entry payload digests when present.
2. **Trust** verifies Ed25519 signatures when a signed package is supplied.
3. **Unsigned packages** are blocked unless their security-relevant manifest exactly matches the active official same-origin SWIR catalog. Matching now covers identity, version, entry point, type, permissions, file associations, app-data namespace, compatibility, required/optional dependencies, integrity metadata and signature metadata rather than only package identity fields.
4. **Dependencies** must resolve before installation.
5. **Permissions** are surfaced as an explicit review stage and the installer rejects permission grants that were not requested by the manifest.
6. **Install/remove** operations require an explicit `approved: true` decision and never run silently.

## SWIR Store 2.3 integration

SWIR Store no longer calls `SwirPlatform.packages.install()` directly. The `SECURE INSTALL` action first executes `SwirInstallPipeline.prepare()`, renders the five pipeline stages, shows requested permissions, then calls `SwirInstallPipeline.install()` only after explicit approval.

Imported `.swirapp` manifests that claim the identity of an official catalog package are rejected if any security-relevant field differs from the current catalog. This prevents an altered unsigned manifest from inheriting `UNSIGNED_CATALOG` trust merely by preserving `id`, `packageId`, `version` and `entry`.

Removal also goes through `SwirInstallPipeline.remove()` so dependency protection remains part of the shared install policy.

## Desktop migration

Desktop Edition should keep this orchestration contract and replace only adapters below it:

- package payload reader
- native filesystem installer
- OS permission broker
- process/application registrar
- trusted system key source
- updater/rollback backend

This keeps package policy portable while native capabilities remain behind runtime-specific adapters.

## States

Typical trust states include:

- `VERIFIED` — cryptographic signature verified with a trusted key
- `UNSIGNED_CATALOG` — exact official Web Edition catalog match, allowed for backwards compatibility
- `UNSIGNED_BLOCKED` — unsigned package not accepted
- `UNKNOWN_KEY`, `OUT_OF_SCOPE`, `BAD_SIGNATURE` — fail-closed trust failures

The system must never display `UNSIGNED_CATALOG` as equivalent to a verified publisher signature.
