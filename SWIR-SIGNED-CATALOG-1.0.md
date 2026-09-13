# SWIR Signed Catalog Metadata 1.0

SWIR OS uses a fail-closed verification contract for signed package-catalog metadata. The purpose is to let Web, Desktop and future System editions consume one catalog trust model without embedding a private signing key in the client.

## Contract

Schema: `swir.catalog-signature/1.0`

Verifier implementation: `SWIR Catalog Integrity 1.1`

Algorithm: `Ed25519`

Digest: `SHA-256`

Canonical catalog ID: `official`

Trust-store scope: `catalog:official`

A signature envelope contains:

```json
{
  "schema": "swir.catalog-signature/1.0",
  "catalogId": "official",
  "catalogVersion": "2026.09.13.1",
  "sequence": 41,
  "generatedAt": "2026-09-13T07:55:00Z",
  "expiresAt": "2026-09-14T07:55:00Z",
  "algorithm": "Ed25519",
  "keyId": "swir-catalog-release-1",
  "catalogSha256": "<64 lowercase hex characters>",
  "signature": "<base64 Ed25519 signature>"
}
```

The signed payload is the canonical JSON object containing `schema`, `catalogId`, `catalogVersion`, `sequence`, `catalogSha256`, `generatedAt` and `expiresAt`. The catalog digest is calculated from a stable, key-sorted representation of all package records sorted by package ID and version.

`sequence` is a strictly monotonic release number. It is security metadata rather than a display version. `catalogVersion` may remain human-readable, while clients use `sequence` for anti-rollback decisions.

## Trust and freshness model

The browser/runtime contains only public verification material. Private signing keys must remain outside the repository and outside shipping SWIR OS clients. A trusted key must be present in `SwirTrustedKeys` and explicitly scoped to `catalog:official` before a catalog signature can verify.

Unknown keys, wrong scope, malformed envelopes, digest mismatch, unsupported catalog IDs and invalid cryptographic signatures fail closed.

A cryptographically valid signature is not sufficient by itself. `SwirCatalogIntegrity.verifyPolicy()` additionally rejects:

- `EXPIRED` metadata after `expiresAt`, allowing only the configured clock-skew tolerance,
- `FUTURE_METADATA` generated implausibly far ahead of the local verification clock,
- `ROLLBACK_DETECTED` when `sequence` is below the previously trusted high-water mark,
- `EQUIVOCATION_DETECTED` when the same trusted sequence is reused with a different catalog digest.

The default maximum clock skew is five minutes. Tests and controlled callers may override it explicitly.

## Persistent high-water state

`window.SwirCatalogTrustState` implements `swir.catalog-trust-state/1.0`. It persists the last accepted official catalog through `SwirPlatform.storage` and stores only public trust metadata:

```text
catalogId
catalogVersion
sequence
catalogSha256
keyId
generatedAt
expiresAt
acceptedAt
```

`verifyAndAccept()` first reads the previous trusted state, feeds its sequence/digest into the verifier, and updates storage only after the new envelope passes cryptographic verification and policy checks. A rejected replay or rollback cannot lower the stored high-water mark.

This storage is not a replacement for signature verification. It is persistent anti-rollback memory layered on top of Ed25519 trust.

## Runtime API

`window.SwirCatalogIntegrity` exposes:

```text
fingerprintCatalog(catalog)
validateEnvelope(envelope)
signedPayload(envelope)
verifyPolicy(envelope, policy)
verify(envelope, catalog, trustStore, policy)
describe(catalog)
```

`window.SwirCatalogTrustState` exposes:

```text
state()
verifyAndAccept(envelope, catalog, trustStore, options)
describe()
```

The terminal command `catalog` displays the current official catalog fingerprint and persistent trust high-water mark when one has been accepted. Diagnostic fingerprint output alone never converts an unsigned catalog into a trusted catalog.

## Native Desktop verifier

`desktop/windows/DesktopCatalogTrustVerifier.cs` is the native counterpart of the browser verifier. It independently validates the `swir.catalog-signature/1.0` envelope inside the .NET Desktop Host and does not depend on JavaScript trust decisions.

It currently enforces:

- canonical catalog SHA-256 verification,
- Ed25519 signature verification against explicitly supplied public trust roots,
- the `catalog:official` trust scope,
- `generatedAt` / `expiresAt` freshness with bounded clock skew,
- a persistent native sequence high-water mark under the Desktop Host data root,
- rollback and same-sequence equivocation rejection,
- exact `packageId` + `version` lookup only after the catalog is trusted,
- extraction of the installer digest from signed `artifacts.desktop.sha256` metadata (with `packageSha256` retained as a compatibility field),
- fail-closed rejection when a trusted Desktop artifact digest is absent.

Native self-tests generate an ephemeral Ed25519 keypair and exercise valid authorization, bad signatures, unknown keys, expiry, rollback after restart-state advancement and missing Desktop artifact digests. The private test key exists only in the self-test process.

The Desktop Host pins its Ed25519 verification library to a .NET 8-compatible version. Production private signing material is still deliberately absent from the repository.

## Release pipeline direction

Production publishing should:

1. build the official catalog from reviewed package metadata,
2. canonicalize and hash it,
3. increment the monotonic catalog `sequence`,
4. choose bounded `generatedAt` / `expiresAt` timestamps,
5. sign the complete metadata envelope in a protected release environment,
6. publish the catalog and envelope together,
7. verify signature, freshness and anti-rollback policy before Store/Package Core accepts catalog mutations,
8. preserve previous trusted metadata for rollback/audit without allowing it to become an install-trust downgrade path.

The repository intentionally does **not** contain a production private signing key. CI self-tests generate an ephemeral Ed25519 keypair, sign fixtures, verify valid metadata, then verify that catalog tampering, unknown keys, bad signatures, expiry, future timestamps, rollback and same-sequence equivocation are rejected. The tests also advance a persisted high-water mark and prove that replaying an older signed catalog does not modify it.

## Desktop/System requirement

The native trust verifier is now implemented and CI-verified, but the Desktop/System `package signatures and integrity verification` roadmap item remains **not complete**. The shipping package mutation path still needs to consume authorization from `DesktopCatalogTrustVerifier` instead of accepting an arbitrary digest supplied by UI/runtime code. The official catalog also still needs signed Desktop artifact hashes, production public-root provisioning and a protected release-signing pipeline. These requirements must be completed and exercised through shipping install/update E2E before the roadmap checkbox can become `[x]`.
