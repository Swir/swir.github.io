# SWIR Install Pipeline 1.0

SWIR OS 1.7.10 introduces a portable installation pipeline intended to be shared by Web Edition, Desktop Edition and later System Edition.

## Flow

`INTEGRITY → TRUST → DEPENDENCIES → PERMISSIONS → INSTALL`

The pipeline is implemented in `swir-install-pipeline.js` and exposed through App SDK 1.6.

## Security model

1. **Integrity** validates manifest and entry payload digests when present.
2. **Trust** verifies Ed25519 signatures when a signed package is supplied.
3. **Unsigned packages** are blocked unless they exactly match the active official same-origin SWIR catalog. This preserves Web Edition compatibility without treating unsigned catalog packages as cryptographically trusted.
4. **Dependencies** must resolve before installation.
5. **Permissions** are surfaced as an explicit review stage.
6. **Install/remove** operations require an explicit `approved: true` decision and never run silently.

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
