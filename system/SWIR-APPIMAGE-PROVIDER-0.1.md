# SWIR AppImage User Package Provider 0.1

Status: **implemented experimental managed-import provider / stronger sandboxing and System-image E2E pending**

This provider adds a deliberately narrow AppImage path behind the common System Package Provider layer. It does not download AppImages, add repositories, invoke a shell, or claim that the AppImage format itself provides isolation.

## Trust and source model

`swir.package.appimage` accepts only `linux-native` System Edition manifests using `swir.package-provider/0.2` with:

- `package.scope = user`;
- an opaque `package.sourceRef` rather than a URL/path;
- a managed absolute `package.nativeEntryPoint` under the configured SWIR AppImage install root;
- a lowercase SHA-256 digest in `package.sha256`;
- `trust.sourceClass = swir-signed`;
- `trust.signatureRequired = true`.

Install/update execution additionally requires explicit `signatureVerified: true` evidence from the caller and an absolute local `artifactPath`. The local artifact is hashed before mutation and the copied payload is hashed again before the atomic rename into the managed install location.

Arbitrary HTTP(S) downloads are intentionally outside this provider. Download/catalog verification belongs to the Store/package acquisition layer and must deliver already verified signature evidence plus the exact signed digest.

## Transaction and recovery model

The provider owns a per-user install root, transaction journal and rollback directory. Mutations are staged as:

```text
signed manifest + verified local artifact
        |
        v
validate provider / scope / managed target / SHA-256
        |
        v
write prepared transaction journal
        |
        +--> update/remove: move current payload to managed rollback backup
        |
        +--> install/update: copy to unique temp file -> chmod 0700 -> verify SHA-256 again
        |
        v
atomic rename into managed target
        |
        v
commit journal
```

A mutation failure removes the temporary payload and restores the previous backup when present. `recoverPending()` scans only SWIR transaction journals and repairs transactions left in `prepared` state after interruption.

## Execution boundary

AppImage is **not** treated as a sandbox format. The plan exposes `formatProvidesSandbox: false` and requires execution to remain behind SWIR permission/trust policy. A dedicated integration self-test installs an AppImage-style executable into an isolated managed root and launches it through `NativePackageExecutionService`, which still enforces signature trust, approved launch roots and `shell=false`.

Future production promotion should add an explicit sandbox profile (for example a reviewed bubblewrap/portal policy where suitable) before broadly enabling third-party AppImages.

## Common provider integration

The stable `createSystemPackageProviderLayer()` factory remains distribution-only. `createExperimentalSystemPackageProviderLayer()` can opt in to AppImage only when an explicit managed `appImageInstallRoot` is supplied. Store/UI code still cannot inject arbitrary providers.

## Verification

- `appimage-user-package-provider.selftest.mjs` covers install/update/remove, signature gating, SHA-256 verification, managed-target enforcement and rollback metadata.
- `system/e2e/appimage-native-execution.selftest.mjs` exercises managed install -> trusted native launch -> clean process exit on Linux.
- `package-provider-layer.selftest.mjs` verifies that production remains fail-closed while the experimental composition can explicitly provision AppImage.
- `system-appimage-provider-contract.yml` runs syntax, schema, lifecycle and native execution checks on Ubuntu.

## Remaining production gates

This foundation is intentionally not enough to mark the full System Package Provider roadmap item complete. Remaining gates include a real signed acquisition/catalog path, stronger sandbox/portal policy, bounded rollback retention, desktop-file/icon integration, and disposable System-image E2E on the selected Linux base.
