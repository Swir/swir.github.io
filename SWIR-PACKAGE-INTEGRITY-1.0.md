# SWIR Package Integrity 1.0

## Goal

SWIR Package Integrity defines portable verification primitives shared by Web, Desktop and future System editions. It is the trust layer that sits before dependency resolution and installation.

```text
.SWIRAPP / manifest
      |
      v
SWIR Package Integrity
      |
      +--> canonical manifest fingerprint
      +--> SHA-256 manifest verification
      +--> SHA-256 entry/payload verification
      +--> signature descriptor validation
      |
      v
SWIR Package Resolver
      |
      v
Permissions review
      |
      v
Install / register package
```

## Runtime service

Web Edition exposes:

```text
window.SwirPackageIntegrity
```

Current service version: `1.0.0`

Schemas:

```text
swir.integrity/1.0
swir.signature/1.0
```

The implementation uses the Web Crypto API for SHA-256. Desktop/System adapters can expose the same contract using native cryptographic libraries.

## App SDK 1.4 API

```text
SwirAppSDK.packages.fingerprint(packageIdOrManifest)
SwirAppSDK.packages.verifyManifest(packageIdOrManifest, expectedSha256?)
SwirAppSDK.packages.verifyEntry(packageIdOrManifest)
SwirAppSDK.packages.integrityPlan(packageIdOrManifest, options?)
SwirAppSDK.packages.validateSignatureDescriptor(signature)
```

`fingerprint()` canonicalizes the manifest before hashing so object key ordering does not change the digest. `integrity` and `signature` fields are excluded from the manifest payload fingerprint to avoid self-referential hashes.

## Manifest integrity block

Future package manifests can include:

```json
{
  "integrity": {
    "algorithm": "SHA-256",
    "manifestSha256": "<64 hex chars>",
    "entrySha256": "<64 hex chars>"
  }
}
```

If no digest is pinned, Web Edition reports `UNPINNED` rather than pretending the package is verified. A digest mismatch produces a failed verification result and future installers must stop before dependency/permission/install phases.

## Signature descriptor

Planned `signature.json` shape:

```json
{
  "schema": "swir.signature/1.0",
  "packageId": "swir.code",
  "version": "1.1.0",
  "algorithm": "Ed25519",
  "keyId": "swir-release-2026",
  "manifestSha256": "<64 hex chars>",
  "signature": "<encoded signature>"
}
```

Version 1.0 validates descriptor structure only. It intentionally does **not** claim cryptographic signature authenticity yet. The next security milestone is a trusted-key store plus real Ed25519 verification in Desktop/System adapters.

## Security invariants

- A package manifest is metadata, not authority.
- SHA-256 verifies integrity, not publisher identity.
- Unsigned or unpinned packages must never be displayed as cryptographically trusted.
- Signature verification must happen against a trusted key source, not a key shipped only inside the package being verified.
- Failed integrity verification must stop installation before permissions are granted or payloads are executed.
- Web Edition remains restricted to official same-origin package entries.

## Desktop Edition target pipeline

```text
SELECT / DOWNLOAD .swirapp
  -> PARSE PACKAGE
  -> VERIFY MANIFEST SHA-256
  -> VERIFY PAYLOAD SHA-256
  -> VERIFY SIGNATURE + TRUSTED KEY
  -> RESOLVE OS / SDK / API / DEPENDENCIES
  -> DISPLAY PERMISSIONS
  -> CREATE APP DATA
  -> INSTALL PAYLOAD
  -> REGISTER FILE TYPES
  -> REGISTER VERSION
  -> LAUNCH
```

This ordering prevents a package from reaching the installation or execution phase before its integrity and trust state are known.
