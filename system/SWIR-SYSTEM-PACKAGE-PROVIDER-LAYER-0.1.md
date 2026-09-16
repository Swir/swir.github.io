# SWIR System Package Provider Layer 0.1

Status: **implemented common routing foundation / experimental Flatpak + cryptographically authorized managed AppImage providers / System-image E2E pending**

`system/packages/package-provider-layer.mjs` is the edition-neutral System package routing boundary above concrete Linux package providers. Store/Update Center code gets one stable surface for native Linux package planning/execution without invoking package managers or arbitrary commands directly.

## Current composition

```text
System Store / Update Center
        |
        v
SystemPackageProviderLayer
        |
        +--> swir.package.system   -> DistributionPackageStackAdapter
        |                             -> trust + Polkit + snapshot + journal + guarded pkexec
        |
        +--> swir.package.flatpak  -> experimental user-scope adapter
        |                             -> preconfigured allowlisted remote
        |                             -> guarded /usr/bin/flatpak, shell=false
        |
        +--> swir.package.appimage -> experimental managed-import adapter
                                      -> native Ed25519 signed-catalog authorization
                                      -> exact version/sourceRef/SHA-256 binding
                                      -> managed per-user root + journal + crash recovery
                                      -> no network acquisition
```

The stable production factory `createSystemPackageProviderLayer()` remains distribution-only. It does not accept arbitrary adapter injection and does not silently enable experimental providers.

`createExperimentalSystemPackageProviderLayer()` is an explicit opt-in composition for development/System-image integration. Flatpak requires one or more allowlisted remote IDs. AppImage requires both an explicit managed install root and a host-provisioned `SystemCatalogTrustVerifier`; supplying only one fails closed. Store/UI code still cannot register arbitrary providers.

## Contract

The layer accepts `swir.package-provider/0.2` manifests only when `targetEditions` contains `system`, `executionClass` is `linux-native`, the provider is one of the three reviewed Linux providers, and the operation is `install`, `update` or `remove`.

Provider-specific security remains inside each adapter. Distribution mutation delegates to the privileged transaction stack. Flatpak 0.1 is fixed to user scope and reviewed argv templates. AppImage 0.1 is a local managed-import path that requires an exact package version, the official SWIR signed catalog and the exact catalog-authorized SHA-256; it has no download URL support.

## AppImage 0.1 trust boundary

AppImage install/update cannot be authorized with a caller-selected boolean. The native System catalog verifier reuses the existing `swir.catalog-signature/1.0` / `catalog:official` Ed25519 trust model, recomputes the canonical catalog SHA-256, validates freshness and high-water anti-rollback state, rejects same-sequence equivocation, verifies the cryptographic signature and binds exact package id/version/sourceRef/digest from `artifacts.system.appimage` to the manifest.

The verifier emits an opaque in-process authorization branded by the verifier module. The managed executor rejects lookalike objects, so direct callers cannot forge trust merely by reproducing the visible authorization fields.

AppImage remains explicitly non-sandboxed at the format level. The provider records `formatProvidesSandbox: false`; execution must still pass through SWIR trust/permission and native-launch policy.

## Transaction safety

Install/update hash the local artifact before mutation and hash the copied temporary payload again before atomic rename. A prepared transaction journal is written first. Existing payloads are moved to a managed recovery backup before update/remove.

Recovery is path-constrained: journal id, package id, operation, target, backup and temporary file are validated against the configured managed roots before any filesystem mutation. Symlink managed targets are rejected. Root, journal and recovery directories are forced to mode `0700`.

The implementation supports crash recovery, but it does **not** yet advertise a public committed AppImage rollback feature. `rollbackImplemented` remains false until a version-aware, user-facing rollback API and bounded backup-retention policy exist.

## Security invariants

- no shell or child-process execution in the common routing layer;
- no arbitrary provider identifiers or production adapter injection;
- plan provider/operation identity is rechecked by the router;
- Flatpak full argv is revalidated immediately before spawn;
- AppImage has no built-in network acquisition and cannot trust a caller-selected verification boolean;
- AppImage requires native Ed25519 catalog authorization plus exact digest binding for install/update;
- AppImage does not claim sandbox isolation that the format does not provide;
- Windows compatibility packages remain behind the separate Wine/Proton service;
- distribution recovery remains provider-owned rather than synthesized by Store UI.

## Verification

`package-provider-layer.selftest.mjs` covers production fail-closed behavior and explicit experimental Flatpak/AppImage routing with real ephemeral Ed25519 catalog authorization. `flatpak-user-package-provider.selftest.mjs` covers remote/argv enforcement. `appimage-user-package-provider.selftest.mjs` covers cryptographic trust, anti-rollback, digest binding, install/update/remove, forged-authorization rejection and malicious-journal path rejection. `system/e2e/appimage-native-execution.selftest.mjs` verifies signed catalog authorization followed by managed install and trusted native launch on Linux.

Dedicated provider workflows protect the experimental adapters while the aggregate System Edition workflow protects the wider distribution/security stack.

## Roadmap meaning

The common provider layer now has reviewed foundations for distribution packages, Flatpak and AppImage, and AppImage is connected to the existing signed-catalog trust model rather than a boolean trust assertion. The System Edition roadmap checkbox remains open because these experimental providers still require production System-image E2E; Flatpak still needs version-aware SWIR rollback, and AppImage still needs production root/state provisioning, an acquisition/cache service, stronger sandbox/portal policy, committed rollback + bounded backup retention and desktop/icon integration before broad production enablement.
