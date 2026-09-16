# SWIR Managed Windows Compatibility Runtime Registry 0.1

Status: **implemented trusted discovery + package-layer provisioning foundation / System image E2E and prefix migration pending**

The existing `WindowsCompatibilityService` already enforces per-app prefixes, signed/trusted package gating, `.exe/.com` user-application entry points, approved runtime roots, filtered environment variables and `shell=false` execution. The managed registry decides which locally installed Wine/Proton runtime is trusted enough to hand to that service, while the provisioning layer now defines how an approved runtime package can be installed or updated through the reviewed System package transaction stack.

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

No runtime is downloaded by discovery. Discovery is bounded by scan-depth and entry-count limits.

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

## Package-layer provisioning

`system/runtime/windows-compat-runtime-provisioner.mjs` adds a provisioning boundary for Wine/Proton packages. It does not run package managers and it does not accept runtime download URLs or executable paths.

A reviewed `swir.compat-runtime-provisioning-catalog/0.1` entry maps a runtime provider to a `swir.package.system` manifest whose source is an allowlisted, signature-verified distribution repository. The provisioner delegates `install` or `update` to `SystemPackageProviderLayer`, which in turn uses the existing trust + Polkit + snapshot + journal + guarded-pkexec stack.

```text
reviewed compatibility catalog
        |
        v
WindowsCompatibilityRuntimeProvisioner
        |
        v
SystemPackageProviderLayer (swir.package.system)
        |
        v
journaled privileged package transaction
        |
        v
trusted runtime rediscovery
        |
        +--> healthy Wine/Proton accepted -> verified
        +--> no healthy runtime           -> fail closed / recovery required
```

An install is skipped as `already-present` when the trusted registry already contains a healthy runtime for that provider. After a real package transaction, success is not accepted until the trusted registry rediscovers a healthy matching runtime. A package-manager success without a trusted runtime becomes `RUNTIME_VERIFICATION_FAILED`; the result explicitly signals that recovery is required instead of pretending the runtime is usable.

The catalog schema intentionally has no fields for runtime executable paths, arbitrary repository URLs or direct download URLs. Windows kernel drivers remain outside this path.

## Security properties

- no web download or arbitrary runtime URL support;
- no arbitrary runtime path accepted by the managed composition or provisioning catalog;
- no direct package-manager execution by the provisioner;
- provisioning is restricted to `swir.package.system` distribution manifests with signatures required;
- no group/world-writable executable accepted by trusted discovery;
- no compatibility runtime outside approved roots after symlink resolution;
- no shell execution for version probes or application launch;
- post-transaction trusted rediscovery is mandatory;
- Windows kernel drivers remain outside this design and are not treated as Linux drivers.

## Verification

`windows-compat-runtime-registry.selftest.mjs` creates isolated Wine/Proton fixtures and verifies trusted discovery, unhealthy/rejected candidate behavior, runtime pinning and service options. `managed-windows-compatibility-stack.selftest.mjs` verifies composition with the existing compatibility service.

`windows-compat-runtime-provisioner.selftest.mjs` verifies catalog restrictions, distribution-package binding, install/update delegation, already-present behavior, recovery delegation and mandatory post-transaction trusted rediscovery. The dedicated runtime provisioner contract workflow verifies the provisioning foundation on Ubuntu; the existing aggregate System Edition workflow continues to exercise the registry, managed compatibility stack and package transaction stack that the provisioner composes.

## Remaining production gates

This is still not enough to mark the full managed Wine/Proton roadmap deliverable complete. Remaining gates are a root-owned System-image provisioning catalog with real distro-specific package mappings, packaged prefix bootstrap/migration, and disposable System-image E2E covering install/update, Windows application launch, restart, failure and rollback/recovery using real Wine/Proton binaries.
