# SWIR OS System Edition — Distribution Package Provider 0.1

## Purpose

This prototype turns the reserved `swir.package.system` provider into a real, testable **planning layer** for Linux distribution packages while deliberately keeping privileged package mutation disabled. It is the first concrete step toward the common System Edition Package Provider layer described by Architecture 0.1.

The provider consumes a `swir.package-provider/0.2` manifest with `executionClass: linux-native`, `provider: swir.package.system`, and a trusted `distribution-repository` source. `package.sourceRef` names the distribution package and `package.nativeEntryPoint` describes the expected post-install executable used later by the guarded native launcher.

## Supported host managers

The provider can select among detected host package managers:

```text
Debian/Ubuntu   -> apt
Fedora/RHEL     -> rpm-ostree first, then dnf
Arch            -> pacman
SUSE            -> zypper
unknown family  -> first supported manager detected by the host inventory
```

Detection input is compatible with the read-only host capability shape already produced by the System Hardware Service. No command is executed by this provider.

## Plan contract

Install, update and remove calls emit `swir.system-package-plan/0.1` with:

- `mode: preview`;
- `readOnly: true`;
- `autoExecutable: false`;
- selected host package manager;
- distribution repository identity;
- signature verification required;
- arbitrary repository URLs forbidden;
- privileged mutation required;
- journal required;
- health-check/rollback metadata;
- a human/audit `commandPreview` represented as an argv array.

The preview command is not authorization to execute. Methods named `install`, `update`, `remove` and `rollback` fail closed with `PACKAGE_MUTATION_BROKER_REQUIRED` until a privileged System Package Transaction Service exists.

## Trust model

The prototype accepts only `distribution-repository` manifests with `signatureRequired: true`. If a manifest names `trust.repositoryId`, deployments can supply an allowlist and an unknown repository is rejected before a plan is returned.

This keeps repository selection separate from arbitrary web URLs and follows the existing System Edition trusted-source policy. Vendor driver repositories remain part of the separate Driver Center policy and are not silently accepted as general application package sources.

## Rollback model

`rpm-ostree` plans can report deployment rollback as provider-supported. Traditional mutable package managers remain conservative: rollback is reported unsupported until the future transaction service records the exact pre-mutation package version/state needed to make rollback deterministic.

## Roadmap gate

This planning provider advances the future **common Package Provider layer for distribution packages and later Flatpak/AppImage**, but does not complete that roadmap item. Completion still requires an authenticated privileged mutation broker, real package database resolution, download/signature verification, journaled install/update/remove, health checks, rollback/recovery, native launcher integration, and end-to-end tests on the selected System Edition Linux base.
