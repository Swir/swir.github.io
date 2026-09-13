# SWIR Desktop Catalog Trust Root Provisioning 1.0

This document defines how SWIR OS Desktop Edition provisions public Ed25519 roots used to authorize official package-catalog metadata. Private signing keys never belong in the Desktop Host, repository, Web runtime, or package payload.

## Shipping file

The Desktop Host ships `catalog-trust-roots.json` next to the executable. Its schema is:

```json
{
  "schema": "swir.catalog-trust-roots/1.0",
  "roots": []
}
```

An empty root list is intentional in source builds until a reviewed production public root is provisioned by the release process.

A deployment may override the file location with the `SWIR_CATALOG_TRUST_ROOTS` environment variable. This is intended for controlled packaging/testing and must resolve to a local file managed by the trusted deployment path.

## Root record

Enabled roots must contain:

```json
{
  "keyId": "swir-catalog-release-1",
  "name": "SWIR official catalog release root",
  "algorithm": "Ed25519",
  "format": "raw",
  "publicKey": "<base64 32-byte public key>",
  "scope": ["catalog:official"],
  "enabled": true
}
```

`DesktopCatalogTrustRootStore` rejects malformed schema, duplicate key IDs, unsupported algorithms/formats, invalid base64, non-32-byte Ed25519 raw keys and roots that are not scoped to `catalog:official` (or explicit `*`).

## Enforcement transition

`DesktopPackageBridge` operates in two explicit modes:

- `LEGACY_SHA_UNTIL_ROOT_PROVISIONED` when no native catalog root exists. This preserves current preview compatibility but is not considered production package trust.
- `SIGNED_CATALOG_REQUIRED` immediately after at least one valid native root is provisioned. In this mode arbitrary SHA-256 values supplied by UI/runtime code are rejected with `CATALOG_AUTHORIZATION_REQUIRED`.

Signed mode accepts `swir.desktop-catalog-authorization/1.0`, containing the candidate catalog, signature envelope, exact `packageId` and exact `version`. The bridge calls `DesktopCatalogTrustVerifier.VerifyAndAuthorize(...)`; only the SHA-256 returned from that native authorization is passed into `DesktopAppPackageInstaller`.

This means a provisioned production root changes the trust boundary: JavaScript may transport signed metadata, but it can no longer choose the artifact hash that the native installer trusts.

## Security properties

The native chain is:

```text
provisioned public root
        |
        v
Ed25519 catalog envelope
        |
        +--> SHA-256 catalog digest
        +--> freshness / expiry
        +--> sequence high-water anti-rollback
        +--> same-sequence equivocation defense
        |
        v
exact packageId + version
        |
        v
signed Desktop artifact SHA-256
        |
        v
capability-bound .swirapp file
        |
        v
DesktopAppPackageInstaller
```

Capability tokens remain owner-bound and are consumed after an install attempt. Dependency preflight still runs before payload mutation. Installer staging, package health verification, `Current/Previous` slots and rollback remain unchanged.

## Production release requirement

The roadmap item `package signatures and integrity verification` remains incomplete until all of the following are true and CI/E2E verified:

1. a production public catalog root is provisioned into release artifacts;
2. its corresponding private key is held only by a protected release-signing environment;
3. the official catalog publishes signed Desktop artifact hashes for installable versions;
4. Store/runtime submits signed catalog authorization rather than the legacy digest form;
5. shipping Desktop E2E proves install/update/restart/rollback with signed authorization;
6. the legacy SHA fallback is disabled for production releases.

Do not mark the roadmap deliverable complete merely because the verifier or transition switch exists.
