# SWIR System Package Provider Layer 0.1

Status: **implemented common routing foundation / Flatpak and AppImage providers intentionally not provisioned yet**

`system/packages/package-provider-layer.mjs` is the edition-neutral System package routing boundary that sits above concrete Linux package providers. It gives Store/Update Center code one stable surface for native Linux package planning and execution without allowing UI/runtime code to invoke a package manager directly.

## Current production composition

```text
System Store / Update Center
        |
        v
SystemPackageProviderLayer
        |
        +--> swir.package.system  -> DistributionPackageStackAdapter
        |                            -> SystemPackageStack
        |                            -> trust + Polkit + snapshot + journal + guarded pkexec
        |
        +--> swir.package.flatpak -> known, fail-closed: not provisioned
        |
        +--> swir.package.appimage -> known, fail-closed: not provisioned
```

The production factory `createSystemPackageProviderLayer()` accepts only the reviewed `distributionStack`. It does **not** accept an arbitrary adapter map. This is deliberate: a future Flatpak or AppImage implementation must be reviewed and wired into the production factory rather than injected by Store/UI code.

## Contract

The layer accepts `swir.package-provider/0.2` manifests only when:

- `targetEditions` includes `system`;
- `executionClass` is `linux-native`;
- the provider is one of `swir.package.system`, `swir.package.flatpak`, `swir.package.appimage`;
- the operation is `install`, `update` or `remove`.

The common layer never generates command lines. Provider-specific planning stays inside the concrete provider. Privileged mutation is delegated to the provider's reviewed transaction service.

`describe()` exposes readiness without pretending planned providers exist. Today the distribution provider reports `ready`; Flatpak and AppImage report `not-provisioned` and operations fail with `PROVIDER_NOT_PROVISIONED`.

## Security invariants

- no shell or child-process execution in the routing layer;
- no arbitrary provider identifiers;
- no arbitrary production adapter injection;
- plan provider/operation identity is checked before it is returned;
- Windows compatibility packages are rejected and remain behind the separate Wine/Proton compatibility service;
- recovery remains provider-owned and cannot be synthesized by the Store.

## Verification

`package-provider-layer.selftest.mjs` verifies distribution routing, execution, recovery, provider identity binding, unsupported-operation rejection, future-provider fail-closed behavior and separation from `windows-compat`.

The dedicated `System Package Provider Layer Contract` workflow and the aggregate `System Edition Contracts` workflow run syntax and self-tests on every relevant change.

## Roadmap meaning

This completes the **common routing foundation** for System package providers. It does not by itself complete the System Edition roadmap checkbox for the full common Package Provider layer because Flatpak/AppImage are still intentionally unprovisioned and real System image E2E remains pending.
