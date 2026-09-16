# SWIR AppImage User Package Provider 0.1

Status: **implemented experimental managed-import provider with native signed-catalog authorization / stronger sandboxing and System-image E2E pending**

This provider adds a deliberately narrow AppImage path behind the common System Package Provider layer. It does not download AppImages, add repositories, invoke a shell, or claim that the AppImage format itself provides isolation.

## Trust and source model

`swir.package.appimage` accepts only `linux-native` System Edition manifests using `swir.package-provider/0.2` with:

- `package.scope = user`;
- an exact `package.version`;
- an opaque `package.sourceRef` rather than a URL/path;
- a managed absolute `package.nativeEntryPoint` under the configured SWIR AppImage install root;
- a lowercase SHA-256 digest in `package.sha256`;
- `trust.sourceClass = swir-signed`;
- `trust.repositoryId = official`;
- `trust.signatureRequired = true`.

Install/update no longer accept a caller-selected `signatureVerified: true` flag. `AppImageUserPackageAdapter` requires a native `SystemCatalogTrustVerifier`, which independently verifies the existing `swir.catalog-signature/1.0` contract with an explicitly provisioned `catalog:official` Ed25519 public root. It verifies catalog canonical SHA-256, signature, freshness, monotonic sequence, same-sequence equivocation protection and exact package id/version lookup before binding the signed `artifacts.system.appimage.{provider,sourceRef,sha256}` record to the manifest.

The verifier returns an in-process authorization object branded by the verifier module. `ManagedAppImageUserExecutor` rejects structurally forged authorization objects even when every visible field is copied. The provider therefore cannot be unlocked by a boolean or by supplying an arbitrary digest from Store/UI code.

Arbitrary HTTP(S) downloads remain intentionally outside this provider. Acquisition belongs to a separate Store/package acquisition layer; this provider receives only a local artifact path after the signed catalog has authorized the exact identity and digest.

## Catalog high-water state

`SystemCatalogTrustVerifier` requires an explicit trust-state adapter rather than silently using ephemeral state. The verifier refuses catalog sequence rollback and rejects reuse of the same sequence with a different catalog digest. CI uses `MemoryCatalogTrustState`; a production System image must provision a durable system-owned state adapter and public roots from the protected release channel.

Private signing keys are never accepted by or embedded in this runtime path.

## Transaction and recovery model

The provider owns a per-user install root, transaction journal and recovery-backup directory. Mutations are staged as:

```text
signed catalog + signature envelope + local artifact
        |
        v
native Ed25519 catalog verification + anti-rollback
        |
        v
exact package/version/sourceRef/SHA-256 authorization
        |
        v
hash local artifact
        |
        v
write prepared transaction journal
        |
        +--> update/remove: move current payload to managed recovery backup
        |
        +--> install/update: copy to unique temp -> chmod 0700 -> hash again
        |
        v
atomic rename into managed target
        |
        v
commit journal
```

A mutation failure removes the temporary payload and restores the previous backup when present. `recoverPending()` repairs transactions left in `prepared` state after interruption. Recovery journals are fail-closed: package id, operation, journal id/file name, target, backup and temporary paths are revalidated against the managed roots before any remove/rename action. Managed roots/journal/backup directories are forced to mode `0700`, and managed targets may not be symlinks.

This is **crash recovery**, not a completed user-facing rollback feature. Committed AppImage rollback is intentionally advertised as `rollbackImplemented: false`; a managed backup may exist after update/remove, but no public committed-rollback API is claimed yet.

## Execution boundary

AppImage is **not** treated as a sandbox format. The plan exposes `formatProvidesSandbox: false` and requires execution to remain behind SWIR permission/trust policy. The integration test now exercises signed catalog verification -> managed AppImage install -> `NativePackageExecutionService` launch -> clean process exit on Linux.

Future production promotion should add an explicit sandbox profile (for example a reviewed bubblewrap/portal policy where suitable) before broadly enabling third-party AppImages.

## Common provider integration

The stable `createSystemPackageProviderLayer()` factory remains distribution-only. `createExperimentalSystemPackageProviderLayer()` can opt in to AppImage only when **both** an explicit managed `appImageInstallRoot` and a native `appImageTrustVerifier` are supplied. Supplying only one side fails closed. Store/UI code still cannot inject arbitrary providers.

## Verification

- `appimage-user-package-provider.selftest.mjs` covers real ephemeral Ed25519 catalog signing, install/update/remove, anti-rollback, catalog tampering, forged-authorization rejection, SHA-256 binding, managed-target enforcement and malicious recovery-journal path rejection.
- `system/e2e/appimage-native-execution.selftest.mjs` exercises signed catalog -> managed install -> trusted native launch -> clean process exit on Linux.
- `package-provider-layer.selftest.mjs` verifies that production remains fail-closed while experimental composition requires an explicit trust verifier and performs a cryptographically authorized AppImage install.
- `system-appimage-provider-contract.yml` runs syntax, schema, cryptographic lifecycle and native execution checks on Ubuntu.

## Remaining production gates

This foundation is intentionally not enough to mark the full System Package Provider roadmap item complete. Remaining gates include a protected production `catalog:official` public-root provisioning path for System Edition, durable system-owned high-water state, a real acquisition/cache service for the signed bytes, stronger sandbox/portal policy, bounded recovery-backup retention plus an explicit committed rollback API, desktop-file/icon integration, and disposable System-image E2E on the selected Linux base.
