# SWIR Signed Catalog Metadata 1.0

SWIR OS uses a fail-closed verification contract for signed package-catalog metadata. The purpose is to let Web, Desktop and future System editions consume one catalog trust model without embedding a private signing key in the client.

## Contract

Schema: `swir.catalog-signature/1.0`

Algorithm: `Ed25519`

Digest: `SHA-256`

Canonical catalog ID: `official`

Trust-store scope: `catalog:official`

A signature envelope contains:

```json
{
  "schema": "swir.catalog-signature/1.0",
  "catalogId": "official",
  "catalogVersion": "2026.09.13",
  "generatedAt": "2026-09-13T00:00:00Z",
  "algorithm": "Ed25519",
  "keyId": "swir-catalog-release-1",
  "catalogSha256": "<64 lowercase hex characters>",
  "signature": "<base64 Ed25519 signature>"
}
```

The signed payload is the canonical JSON object containing `schema`, `catalogId`, `catalogVersion`, `catalogSha256` and `generatedAt`. The catalog digest is calculated from a stable, key-sorted representation of all package records sorted by package ID and version.

## Trust model

The browser/runtime contains only public verification material. Private signing keys must remain outside the repository and outside shipping SWIR OS clients. A trusted key must be present in `SwirTrustedKeys` and explicitly scoped to `catalog:official` (or another deliberately configured scope) before a catalog signature can verify.

Unknown keys, wrong scope, malformed envelopes, digest mismatch, unsupported catalog IDs and invalid cryptographic signatures fail closed.

## Runtime API

`window.SwirCatalogIntegrity` exposes:

```text
fingerprintCatalog(catalog)
validateEnvelope(envelope)
signedPayload(envelope)
verify(envelope, catalog, trustStore)
describe(catalog)
```

The terminal command `catalog` displays the current official catalog fingerprint and package count. This is diagnostic information only; it does not convert an unsigned catalog into a trusted catalog.

## Release pipeline direction

Production publishing should:

1. build the official catalog from reviewed package metadata,
2. canonicalize and hash it,
3. sign the metadata envelope in a protected release environment,
4. publish the catalog and envelope together,
5. verify the signature before Store/Package Core accepts catalog mutations,
6. preserve previous trusted metadata for rollback/audit.

The repository intentionally does **not** contain a production private signing key. CI self-tests generate an ephemeral Ed25519 keypair, sign a fixture, verify the valid signature, then verify that catalog tampering and untrusted-key cases are rejected.
