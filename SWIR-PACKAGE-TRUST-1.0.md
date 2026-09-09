# SWIR Package Trust 1.0

SWIR OS 1.7.9 introduces a portable publisher-trust layer for future Desktop and System editions.

## Trust pipeline

1. Canonicalize the package manifest without `integrity` and `signature` metadata.
2. Verify the pinned SHA-256 manifest digest.
3. Verify the optional entry/payload SHA-256 digest.
4. Resolve `signature.keyId` through the Trusted Key Store.
5. Enforce package scope for the resolved publisher key.
6. Verify the Ed25519 signature over the canonical signature payload.
7. Only then continue to dependency resolution, permissions and installation.

Target flow:

`VERIFY MANIFEST -> VERIFY PAYLOAD -> RESOLVE TRUST KEY -> VERIFY ED25519 -> RESOLVE DEPENDENCIES -> PERMISSIONS -> INSTALL`

## Signature descriptor

Schema: `swir.signature/1.0`

Required fields:

- `schema`
- `packageId`
- `version`
- `algorithm` = `Ed25519`
- `keyId`
- `manifestSha256`
- `signature` (base64)

The signed payload is the canonical JSON form of:

```json
{
  "schema": "swir.signature/1.0",
  "packageId": "publisher.app",
  "version": "1.0.0",
  "manifestSha256": "<64 hex chars>"
}
```

## Trusted Key Store

Runtime API: `window.SwirTrustedKeys`.

System keys are immutable build-time trust anchors. User keys are stored separately and may be added or removed by an explicit local action. A key can be scoped to one or more package IDs or `*`.

Current Web Edition ships with no built-in publisher key yet. This is intentional: the runtime must not claim a package is publisher-authenticated until a real public key is provisioned and the signature verifies cryptographically.

## Algorithms and runtime behavior

- Hash: SHA-256 through Web Crypto.
- Publisher signature: Ed25519 through Web Crypto.
- If Ed25519 is unavailable in the active runtime, signed packages fail closed with `CRYPTO_UNAVAILABLE`.
- Unknown keys fail closed with `UNKNOWN_KEY`.
- Keys outside package scope fail closed with `OUT_OF_SCOPE`.
- Manifest/signature package or version mismatches fail closed.

Unsigned legacy official Web Edition manifests remain compatible with the existing catalog path; the next Store milestone should distinguish clearly between `UNSIGNED CATALOG`, `SIGNED VERIFIED`, and blocked trust states.

## Desktop migration

The trust store and integrity service intentionally avoid DOM/UI dependencies. Desktop Edition can replace browser storage with a native protected key registry while keeping the same logical contract. System Edition can later move system trust anchors to a read-only OS trust database and apply the same verifier before native payload extraction or execution.
