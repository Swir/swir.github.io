# SWIR System Package Provider Layer 0.1

Status: **implemented common routing foundation / experimental Flatpak user provider / AppImage and System-image E2E pending**

`system/packages/package-provider-layer.mjs` is the edition-neutral System package routing boundary that sits above concrete Linux package providers. It gives Store/Update Center code one stable surface for native Linux package planning and execution without allowing UI/runtime code to invoke a package manager directly.

## Current composition

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
        +--> swir.package.flatpak -> experimental reviewed user-scope adapter
        |                            -> preconfigured allowlisted remote
        |                            -> guarded /usr/bin/flatpak, shell=false
        |
        +--> swir.package.appimage -> known, fail-closed: not provisioned
```

The stable production factory `createSystemPackageProviderLayer()` continues to accept only the reviewed `distributionStack`. It does **not** accept an arbitrary adapter map and does not silently enable experimental providers.

`createExperimentalSystemPackageProviderLayer()` is an explicit opt-in composition for development/System-image integration work. It can provision the reviewed Flatpak user adapter only when one or more remote IDs are explicitly allowlisted. It still cannot register arbitrary providers.

## Contract

The layer accepts `swir.package-provider/0.2` manifests only when:

- `targetEditions` includes `system`;
- `executionClass` is `linux-native`;
- the provider is one of `swir.package.system`, `swir.package.flatpak`, `swir.package.appimage`;
- the operation is `install`, `update` or `remove`.

The routing layer never generates command lines. Provider-specific planning stays inside the concrete provider. Privileged distribution mutation is delegated to the reviewed transaction service. Experimental Flatpak 0.1 is user-scoped and therefore does not request root privilege.

`describe()` exposes readiness without pretending unavailable providers exist. The production factory reports distribution `ready`, Flatpak `not-provisioned` with roadmap status `experimental`, and AppImage `not-provisioned`. The experimental factory can report Flatpak `ready` when it is explicitly configured.

## Flatpak 0.1 boundary

The new Flatpak provider is deliberately narrow:

- user scope only (`--user`);
- fixed `/usr/bin/flatpak` binary;
- exact reviewed install/update/uninstall argv templates;
- `shell=false` and minimal environment;
- preconfigured, explicitly allowlisted remote ID;
- Flatpak remote signatures required by manifest policy;
- no remote creation, arbitrary URL, custom command, `--command` injection or system-scope escalation.

Flatpak/OSTree supplies native transaction atomicity for this experimental path. SWIR version-aware Flatpak rollback metadata is not implemented yet, so the provider remains experimental and does not complete the roadmap checkbox.

## Security invariants

- no shell or child-process execution in the common routing layer;
- no arbitrary provider identifiers;
- no arbitrary production adapter injection;
- plan provider/operation identity is checked before it is returned;
- Flatpak execution is isolated in its reviewed adapter and full argv is revalidated before spawn;
- Windows compatibility packages are rejected and remain behind the separate Wine/Proton compatibility service;
- distribution recovery remains provider-owned and cannot be synthesized by the Store.

## Verification

`package-provider-layer.selftest.mjs` verifies distribution routing, execution, recovery, provider identity binding, unsupported-operation rejection, production fail-closed behavior, experimental Flatpak routing and separation from `windows-compat`.

`flatpak-user-package-provider.selftest.mjs` verifies remote allowlisting, manifest binding, exact command templates, tamper rejection, user scope, shell isolation and failure behavior. Dedicated provider workflows and the aggregate System Edition Contracts protect the existing distribution path from regressions.

## Roadmap meaning

This materially advances the common Package Provider layer: distribution packages are on the production transaction stack and a reviewed Flatpak user provider now exists behind explicit experimental composition. The System Edition roadmap checkbox remains open because AppImage is not implemented, Flatpak lacks production System-image E2E/version-aware rollback, and the bootable System Edition image itself is not yet available.
