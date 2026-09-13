# SWIR Desktop Catalog Trust Root Provisioning 1.0

This document defines how SWIR OS Desktop Edition provisions public Ed25519 roots used to authorize official package-catalog metadata. Private signing keys never belong in the Desktop Host, repository, Web runtime, or package payload.

## Shipping file

The Desktop Host ships `catalog-trust-roots.json` next to the executable. Its source-build template is:

```json
{
  "schema": "swir.catalog-trust-roots/1.0",
  "requireSignedCatalog": false,
  "roots": []
}
```

An empty root list with `requireSignedCatalog: false` is intentional only for source/preview builds until a reviewed production public root is provisioned by the release process.

A deployment may override the file location with the `SWIR_CATALOG_TRUST_ROOTS` environment variable. This is intended for controlled packaging/testing and must resolve to a local file managed by the trusted deployment path.

## Production trust lock

Production release packaging must set:

```json
"requireSignedCatalog": true
```

and provision at least one enabled `catalog:official` root. When this lock is enabled, an empty or fully disabled root set is rejected with `CATALOG_TRUST_ROOT_REQUIRED`. The Desktop Host therefore fails closed instead of silently dropping back to raw-SHA preview mode if a production root is accidentally omitted or stripped from the release artifact.

The lock is stored inside the release trust-root document rather than inferred from UI state. A release that claims signed-catalog enforcement must carry both the policy bit and its public verification root.

## Root record

Enabled roots contain:

```json
{
  "keyId": "swir-catalog-release-1",
  "name": "SWIR official catalog release root",
  "algorithm": "Ed25519",
  "format": "raw",
  "publicKey": "<base64 32-byte public key>",
  "scope": ["catalog:official"],
  "enabled": true,
  "notBeforeSequence": 1,
  "retireAfterSequence": 5000
}
```

`notBeforeSequence` defaults to `1`. `retireAfterSequence` is optional. When present it must be greater than or equal to `notBeforeSequence`.

`DesktopCatalogTrustRootStore` rejects malformed schema, duplicate key IDs, unsupported algorithms/formats, invalid base64, non-32-byte Ed25519 raw keys, invalid sequence windows and roots that are not scoped to `catalog:official` (or explicit `*`).

## Sequence-bounded root rotation

Key rotation uses overlap instead of replacing one trusted key with another atomically. A release may provision both current and next public roots while giving each root a monotonic catalog-sequence window.

Example cutover at sequence `5000`:

```json
{
  "schema": "swir.catalog-trust-roots/1.0",
  "requireSignedCatalog": true,
  "roots": [
    {
      "keyId": "swir-catalog-2026-a",
      "name": "SWIR catalog current root",
      "algorithm": "Ed25519",
      "format": "raw",
      "publicKey": "<base64-current>",
      "scope": ["catalog:official"],
      "enabled": true,
      "notBeforeSequence": 1,
      "retireAfterSequence": 5000
    },
    {
      "keyId": "swir-catalog-2026-b",
      "name": "SWIR catalog next root",
      "algorithm": "Ed25519",
      "format": "raw",
      "publicKey": "<base64-next>",
      "scope": ["catalog:official"],
      "enabled": true,
      "notBeforeSequence": 5000
    }
  ]
}
```

At sequence `5000` either key is valid, which gives the release pipeline one controlled overlap point. Before sequence `5000`, the next key fails with `CATALOG_KEY_NOT_ACTIVE`. After sequence `5000`, the previous key fails with `CATALOG_KEY_RETIRED`. The native catalog high-water mark continues to prevent sequence rollback independently of which allowed key signed the catalog.

A safe production rotation order is:

1. ship a Desktop release containing both public roots and their future overlap sequence;
2. keep signing with the current private key until the overlap sequence is reached;
3. sign the cutover catalog with the next key at or after `notBeforeSequence`;
4. verify deployment telemetry/release health before removing the retired public root in a later Desktop release;
5. never lower the catalog sequence or widen a retired key window to recover from an operational mistake.

The private next key must remain in the protected signing environment. Only public raw Ed25519 keys and sequence policy belong in the Desktop release.

## Enforcement transition

`DesktopPackageBridge` operates in two explicit modes:

- `LEGACY_SHA_UNTIL_ROOT_PROVISIONED` when no native catalog root exists and the source/preview policy permits fallback. This is not production package trust.
- `SIGNED_CATALOG_REQUIRED` immediately after at least one valid native root is provisioned. In this mode arbitrary SHA-256 values supplied by UI/runtime code are rejected with `CATALOG_AUTHORIZATION_REQUIRED`.

If `requireSignedCatalog: true` is present but no valid root is available, host construction fails before the legacy mode can be selected.

Signed mode accepts `swir.desktop-catalog-authorization/1.0`, containing the candidate catalog, signature envelope, exact `packageId` and exact `version`. The bridge calls `DesktopCatalogTrustVerifier.VerifyAndAuthorize(...)`; only the SHA-256 returned from that native authorization is passed into `DesktopAppPackageInstaller`.

The bridge then compares the signed `packageId/version` authorization with the actual root `swir-package.json` inside the selected `.swirapp`. A mismatch fails with `CATALOG_PACKAGE_IDENTITY_MISMATCH` before payload mutation. This prevents a catalog publication mistake or confused-deputy flow from authorizing bytes whose manifest declares a different package identity.

This means a provisioned production root changes the trust boundary: JavaScript may transport signed metadata, but it can no longer choose the artifact hash or package identity that the native installer trusts.

## Security properties

The native chain is:

```text
production trust lock
        |
        +--> requires at least one catalog:official public root
        |
        v
provisioned public root
        |
        +--> key-specific sequence activation / retirement window
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
        +--> selected .swirapp manifest identity must match
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
2. production `catalog-trust-roots.json` sets `requireSignedCatalog: true`;
3. its corresponding private key is held only by a protected release-signing environment;
4. the official catalog publishes signed Desktop artifact hashes for installable versions;
5. Store/runtime submits signed catalog authorization rather than the legacy digest form;
6. shipping Desktop E2E proves install/update/restart/rollback with signed authorization;
7. the legacy SHA fallback is unreachable in production release artifacts.

Do not mark the roadmap deliverable complete merely because the verifier, transition switch, identity binding, release lock or root-rotation window exists.
