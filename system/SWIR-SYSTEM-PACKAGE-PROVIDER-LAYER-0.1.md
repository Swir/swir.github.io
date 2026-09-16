# SWIR System Package Provider Layer 0.1

Status: **implemented common routing foundation / experimental Flatpak + managed AppImage providers / System-image E2E pending**

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
                                      -> signed metadata + SHA-256
                                      -> managed per-user root + journal + rollback backup
                                      -> no network acquisition
```

The stable production factory `createSystemPackageProviderLayer()` remains distribution-only. It does not accept arbitrary adapter injection and does not silently enable experimental providers.

`createExperimentalSystemPackageProviderLayer()` is an explicit opt-in composition for development/System-image integration. Flatpak requires one or more allowlisted remote IDs. AppImage requires an explicit managed install root. Store/UI code still cannot register arbitrary providers.

## Contract

The layer accepts `swir.package-provider/0.2` manifests only when `targetEditions` contains `system`, `executionClass` is `linux-native`, the provider is one of the three reviewed Linux providers, and the operation is `install`, `update` or `remove`.

Provider-specific security remains inside each adapter. Distribution mutation delegates to the privileged transaction stack. Flatpak 0.1 is fixed to user scope and reviewed argv templates. AppImage 0.1 is a local managed-import path requiring SWIR-signed trust evidence and an exact SHA-256 digest; it has no download URL support.

## AppImage 0.1 boundary

AppImage is not represented as intrinsically sandboxed. The provider records `formatProvidesSandbox: false` and requires execution to stay behind SWIR trust/permissions. Install/update verify the artifact digest before mutation and again after copy, write a prepared transaction journal, use a unique temporary file and atomic rename, and keep a managed rollback backup for replace/remove operations. Pending prepared journals can be recovered after interruption.

The managed target is derived from the configured install root plus package ID. A manifest cannot redirect installation to `/tmp`, `/usr/bin` or another arbitrary path. The provider accepts an opaque artifact reference rather than a URL and requires explicit `signatureVerified: true` evidence from the acquisition/trust layer.

## Security invariants

- no shell or child-process execution in the common routing layer;
- no arbitrary provider identifiers or production adapter injection;
- plan provider/operation identity is rechecked by the router;
- Flatpak full argv is revalidated immediately before spawn;
- AppImage has no built-in network acquisition, requires signature + digest verification and uses a managed install root;
- AppImage does not claim sandbox isolation that the format does not provide;
- Windows compatibility packages remain behind the separate Wine/Proton service;
- distribution recovery remains provider-owned rather than synthesized by Store UI.

## Verification

`package-provider-layer.selftest.mjs` covers production fail-closed behavior and explicit experimental Flatpak/AppImage routing. `flatpak-user-package-provider.selftest.mjs` covers remote/argv enforcement. `appimage-user-package-provider.selftest.mjs` covers signature gating, SHA-256 verification, install/update/remove and rollback metadata. `system/e2e/appimage-native-execution.selftest.mjs` verifies managed install followed by trusted native launch on Linux.

Dedicated provider workflows protect the two experimental adapters while the aggregate System Edition workflow continues to protect the existing distribution/security stack.

## Roadmap meaning

The common provider layer now has reviewed foundations for distribution packages, Flatpak and AppImage. The System Edition roadmap checkbox remains open because these experimental providers still require production System-image E2E; Flatpak still needs version-aware SWIR rollback, and AppImage still needs stronger sandbox/portal policy, signed acquisition integration, bounded rollback retention and desktop/icon integration before broad production enablement.
