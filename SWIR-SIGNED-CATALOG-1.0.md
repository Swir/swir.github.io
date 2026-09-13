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

## Runtime API

`window.SwirCatalogIntegrity` exposes `fingerprintCatalog`, envelope validation, policy validation, signature verification and catalog description. `window.SwirCatalogTrustState` exposes persisted `state()`, `verifyAndAccept()` and `describe()`.

The terminal command `catalog` displays the current official catalog fingerprint and persistent trust high-water mark when one has been accepted. Diagnostic fingerprint output alone never converts an unsigned catalog into a trusted catalog.

## Native Desktop verifier

`desktop/windows/DesktopCatalogTrustVerifier.cs` is the native counterpart of the browser verifier. It independently validates the `swir.catalog-signature/1.0` envelope inside the .NET Desktop Host and does not depend on JavaScript trust decisions.

It enforces canonical catalog SHA-256, Ed25519 verification against scoped public roots, freshness, persistent native anti-rollback state, same-sequence equivocation rejection, exact `packageId` + `version` lookup and extraction of the installer digest from signed `artifacts.desktop.sha256` metadata. A missing trusted Desktop artifact digest fails closed.

## Shipping Desktop authorization path

`DesktopPackageBridge` consumes `swir.desktop-catalog-authorization/1.0` whenever at least one native `catalog:official` root is provisioned. In that mode, arbitrary SHA-256 values supplied by UI/runtime code are rejected. The bridge asks `DesktopCatalogTrustVerifier` to authorize an exact catalog `packageId` + `version`, receives the signed Desktop artifact digest, binds that identity to the actual root `swir-package.json`, performs dependency preflight, and only then invokes the native `.swirapp` installer.

The shipping bridge advertises `signedIdentityBinding: true` and remains fail-closed after trust-root provisioning. The legacy raw-SHA path exists only while no native catalog root has been provisioned.

## Runtime authorization transport

`SwirRuntime 1.6.0` carries signed Desktop authorization as a structured trust object instead of flattening trust into a caller-selected SHA-256. `catalogAuthorization()` and `installAuthorizedFromCapability()` transport the complete catalog and signature envelope across the native boundary. The Runtime does not decide whether the catalog is trusted; the native verifier repeats cryptographic, freshness and anti-rollback checks independently.

## Release-bound `.swirapp` artifact chain

The Desktop release flow now has a concrete reviewed-package build stage instead of requiring a manually prepared hash map.

`desktop/windows/build-store-packages.ps1`:

1. evaluates the tracked `swir-packages.js` catalog in a constrained Node VM,
2. selects only records explicitly marked `desktop:true`,
3. validates schema, package identity, semantic version and a safe relative entry path,
4. copies the reviewed local entry document and local `./...` dependencies it directly references,
5. writes the catalog record into root `swir-package.json`,
6. creates a ZIP-compatible `.swirapp`,
7. reopens the produced archive and verifies one root manifest plus exact `packageId/version/entry`,
8. computes the real artifact SHA-256,
9. emits `swir.catalog-artifacts/1.0` bound to the exact Git commit.

The protected `SWIR Desktop Release` workflow consumes that generated artifact map directly. It signs the exact `.swirapp` digests with `build-signed-catalog-release.mjs`, stages the resulting public trust-root/catalog bundle into the self-contained Desktop runtime, copies the exact package bytes to `packages/`, and independently compares every staged package hash against both `catalog-artifacts.json` and the signed catalog before building the outer transactional Desktop release bundle.

The final GitHub release artifact set contains the signed Desktop Host bundle, public catalog metadata, artifact map and the individually signed-catalog-bound `.swirapp` files. The private RSA Desktop update key and private Ed25519 catalog key remain secret-only inputs and are not copied into release output.

`Desktop Release Contract` exercises the same chain with an ephemeral CI-only Ed25519 key: real package build → real artifact SHA map → signed catalog → fail-closed public root → signed catalog staging → digest cross-check → transactional Desktop bundle → Candidate → real Host health activation.

## Production publishing rules

A production release must:

1. build reviewed `.swirapp` bytes from the exact release commit,
2. calculate hashes from those final bytes rather than trusting caller-supplied digests,
3. increment the monotonic catalog `sequence`,
4. sign the catalog only inside the protected release environment,
5. stage `requireSignedCatalog:true` plus at least one `catalog:official` public root,
6. cross-check package identity and SHA-256 again before bundling,
7. publish the signed catalog and exact `.swirapp` bytes together,
8. retain previous trusted metadata for audit/rollback without permitting a trust downgrade.

The repository intentionally does **not** contain production private signing keys. CI uses ephemeral signing material only.

## Desktop/System requirement

The native verifier, trust-root loader, signed-catalog enforcement switch, package-identity binding, Runtime structured authorization transport, reviewed `.swirapp` artifact builder and release-bound signed catalog chain are implemented. The Desktop/System `package signatures and integrity verification` roadmap item remains **not complete** until a real production public root is provisioned from the protected secret-backed release environment and an actual published release is exercised through the Store install/update/restart/rollback path. A CI fixture or a technically complete workflow alone does not satisfy that production deliverable.
