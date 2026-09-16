# SWIR Desktop Package Signature 1.0

Status: **implemented and verified Desktop Edition deliverable**

`swir.desktop-package-signature/1.0` defines detached Ed25519 authorization for Desktop Edition `.swirapp` payloads.

## Goals

The contract gives the native Desktop Host a package-level authenticity and integrity decision that is independent from UI-controlled hashes. It complements the signed official catalog rather than replacing it.

A trusted package signature binds all of the following fields:

```text
algorithm = Ed25519
keyId
packageId
schema = swir.desktop-package-signature/1.0
sha256 = SHA-256 of the exact .swirapp bytes
version
```

The canonical signed payload is the UTF-8 JSON serialization of those fields in ordinal key order. Production private signing keys stay outside the repository and client runtime.

## Envelope

```json
{
  "schema": "swir.desktop-package-signature/1.0",
  "algorithm": "Ed25519",
  "keyId": "release-2026",
  "packageId": "swir.example",
  "version": "1.0.0",
  "sha256": "<64 lowercase hex characters>",
  "signature": "<base64 Ed25519 signature>"
}
```

The Desktop Host recomputes SHA-256 from the selected `.swirapp`, compares it in constant time, checks package identity/version against the manifest-derived dependency plan, verifies key scope, imports the pinned raw Ed25519 public key and verifies the signature before payload mutation.

## Release-side signing tool

`scripts/sign-desktop-package.mjs` is the release-side producer for the same canonical envelope. It accepts a `.swirapp`, package identity/version and Ed25519 key identifier, reads the private key only from a named environment variable (default `SWIR_PACKAGE_SIGNING_PRIVATE_KEY_PEM`), hashes the exact package bytes, signs the canonical payload and immediately performs an independent verification before writing public output.

Example release invocation:

```text
SWIR_PACKAGE_SIGNING_PRIVATE_KEY_PEM=<protected PKCS#8 PEM>
node scripts/sign-desktop-package.mjs \
  --package packages/swir.example.swirapp \
  --package-id swir.example \
  --version 1.0.0 \
  --key-id release-2026 \
  --output packages/swir.example.swirapp.sig.json \
  --trust-root-output package-trust-roots.json
```

The signer defaults the generated public root to the least-privilege scope `package:<packageId>`. `package:*` or `*` require an explicit `--scope`. The generated root contains only raw public verification material; the tool refuses to write output containing a private-key marker. It also emits a SHA-256 fingerprint of the raw public key for independent release pinning.

The CI contract runs `node scripts/sign-desktop-package.mjs --self-test` with an ephemeral Ed25519 key before the native verifier tests. This checks deterministic canonical-field ordering, exact-byte hashing, signature length, least-privilege scope, public-key fingerprinting, output hygiene and a tamper digest vector.

Release automation should source `packageId` and `version` from the same verified package-build metadata used to create the `.swirapp`; the Desktop verifier remains the final fail-closed authority and rejects a signature whose identity/version does not match the package manifest.

## Trust roots

Native public roots use `swir.package-trust-roots/1.0` and are provisioned through `package-trust-roots.json` or the `SWIR_PACKAGE_TRUST_ROOTS` deployment override.

Supported scopes are:

```text
*
package:*
package:<exact-package-id>
```

If `requireSignedPackages` is enabled with no valid enabled roots, Desktop Host startup/package service construction fails closed. If package roots are provisioned, arbitrary UI/runtime SHA-256 authorization is disabled.

The source repository intentionally ships an empty preview template. Real release roots must be provisioned by the release process and contain public verification material only.

## Catalog interaction

When catalog trust roots and package trust roots are both provisioned, both checks are required:

```text
signed catalog authorization
        |
        +--> package id/version
        +--> expected bundle SHA-256
        +--> trusted release-local artifact route
        |
        v
package signature envelope
        |
        +--> same package id/version
        +--> same SHA-256
        +--> trusted package signing key/scope
        |
        v
DesktopAppPackageInstaller
```

A standalone package signature can authorize a capability-selected package only when signed-catalog policy is not provisioned. A release configured for signed catalogs cannot bypass catalog policy with a standalone package signature.

For combined authorization, the existing `swir.desktop-catalog-authorization/1.0` wrapper may carry a `packageSignature` object containing the package signature envelope. The signature is independently verified against package trust roots.

## Failure model

Verification fails closed for malformed metadata, invalid digest, missing signature, unknown key, wrong key scope, package identity/version mismatch, bundle hash mismatch and cryptographic signature failure. No payload is promoted to `Current` before the trust decision succeeds.

## Roadmap completion evidence

The Desktop package-signature/integrity deliverable is considered implemented because the shipping Windows host contains the native verifier and trust-root store, the release-side signer produces the same canonical Ed25519 envelope, the package bridge binds signature identity/version/hash to the selected `.swirapp`, and signed install/update/restart/rollback lifecycle tests execute the real native package path. The source tree intentionally contains no production private signing key; release roots remain a deployment input rather than application code.

The `Desktop App Package Contract` workflow builds the shipping Desktop Host and runs the release-side signing self-test, hardened payload tests, capability-bound bridge tests, native Ed25519 signature tests, signed package lifecycle tests, dependency vectors and native catalog trust tests. Any regression in signature/integrity behavior fails the Desktop contract before merge.
