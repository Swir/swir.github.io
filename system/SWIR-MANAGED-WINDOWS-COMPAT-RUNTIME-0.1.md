# SWIR Managed Windows Compatibility Runtime Registry 0.1

Status: **implemented trusted runtime discovery foundation / runtime provisioning and System image E2E pending**

The existing `WindowsCompatibilityService` already enforces per-app prefixes, signed/trusted package gating, `.exe/.com` user-application entry points, approved runtime roots, filtered environment variables and `shell=false` execution. This addition closes a separate production gap: deciding which locally installed Wine/Proton runtime is trusted enough to hand to that service.

## Runtime discovery

`system/runtime/windows-compat-runtime-registry.mjs` scans only approved local roots for known runtime executable names:

```text
swir.compat.wine   -> wine64 / wine
swir.compat.proton -> proton
```

Default roots are:

```text
/usr/bin
/usr/local/bin
/opt/swir/runtimes
/usr/lib/swir/runtimes
```

No runtime is downloaded by this component. Discovery is bounded by scan-depth and entry-count limits.

Every candidate must resolve through `realpath` into an approved root, be a regular executable, be non-group/world-writable and — in the production default — be owned by root. Candidates are version-probed with `shell=false`, a minimal environment and a short timeout. Unhealthy or rejected candidates are visible in the read-only inventory but cannot be selected for launch.

The inventory contract is `swir.compat-runtime-inventory/0.1`. Stable runtime IDs bind provider, resolved executable path and observed version through SHA-256 so a higher layer can explicitly pin a discovered runtime without accepting an arbitrary path.

## Managed composition

`system/runtime/managed-windows-compatibility-stack.mjs` composes the trusted registry with `WindowsCompatibilityService`.

```text
root-owned local Wine/Proton
        |
        v
WindowsCompatibilityRuntimeRegistry
        |  realpath + owner + mode + version probe
        v
approved runtimePaths/runtimeRoots
        |
        v
WindowsCompatibilityService
        |  per-app prefix + trust + no shell
        v
Windows user application
```

The production factory always enables root-ownership enforcement. The lower-level registry exposes an explicit `requireRootOwned:false` mode only so isolated self-tests can create temporary runtime fixtures without privilege; the production composition does not expose that switch.

## Security properties

- no web download or arbitrary runtime URL support;
- no arbitrary runtime path accepted by the managed composition;
- no group/world-writable executable accepted;
- no compatibility runtime outside approved roots after symlink resolution;
- no shell execution for version probes or application launch;
- Windows kernel drivers remain outside this design and are not treated as Linux drivers;
- runtime discovery is read-only and does not mutate prefixes or system packages.

## Verification

`windows-compat-runtime-registry.selftest.mjs` creates isolated Wine/Proton fixtures and verifies trusted discovery, unhealthy/rejected candidate behavior, runtime pinning and service options. `managed-windows-compatibility-stack.selftest.mjs` verifies composition with the existing compatibility service.

The dedicated `System Windows Runtime Registry Contract` workflow and aggregate `System Edition Contracts` workflow run these tests on Ubuntu.

## Remaining production gates

This is not enough to mark the full managed Wine/Proton roadmap deliverable complete. Remaining gates are trusted runtime **provisioning/update transactions** through the System package layer, a packaged prefix bootstrap/migration flow and disposable System-image E2E covering launch, restart, failure and rollback with real Wine/Proton binaries.
