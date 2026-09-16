# SWIR Flatpak User Package Provider 0.1

Status: **implemented experimental user-scope provider / production System image E2E and version-aware rollback pending**

This provider adds a reviewed Flatpak path behind the common System Package Provider layer without weakening the privileged distribution-package path.

## Scope

`system/packages/flatpak-user-package-provider.mjs` supports only:

- `linux-native` manifests using `swir.package.flatpak`;
- user-scoped Flatpak installs (`--user`);
- preconfigured, explicitly allowlisted Flatpak remotes;
- `install`, `update` and `remove` operations;
- fixed `/usr/bin/flatpak` execution with `shell=false` and a minimal environment.

The provider does not add remotes, accept remote URLs, run arbitrary commands, request root privileges, or treat Windows packages as native Linux applications.

## Manifest binding

The provider requires `swir.package-provider/0.2`. For Flatpak packages:

```text
package.sourceRef        = Flatpak application ID
package.nativeEntryPoint = same Flatpak application ID
package.remote           = preconfigured remote name
package.scope            = user
trust.sourceClass        = flatpak-remote
trust.repositoryId       = same remote name
trust.signatureRequired  = true
```

The application ID and remote are character-restricted. The remote must be present in the System image allowlist. Arbitrary repository/download URLs are not accepted.

## Execution boundary

Plans use exact reviewed argv templates:

```text
/usr/bin/flatpak --user --noninteractive install --or-update REMOTE APP_ID
/usr/bin/flatpak --user --noninteractive update APP_ID
/usr/bin/flatpak --user --noninteractive uninstall APP_ID
```

Before execution the guarded executor revalidates provider, operation, scope, trust policy, executable path and the full argument vector. A caller cannot append `--command`, replace the binary, switch to system scope or redirect the operation to another remote.

Flatpak/OSTree supplies the native transaction mechanism for this experimental user-scope path. SWIR version-aware rollback metadata is not implemented yet, so this provider is not sufficient to mark the full Package Provider roadmap deliverable complete.

## Common layer integration

The stable production factory still provisions only `swir.package.system`. An explicit `createExperimentalSystemPackageProviderLayer()` factory can additionally wire the reviewed Flatpak user adapter when the image supplies one or more allowlisted remote IDs. AppImage remains fail-closed and unprovisioned.

## Verification

`flatpak-user-package-provider.selftest.mjs` verifies plan templates, trust/remote policy, argument tamper rejection, user-scope enforcement, shell isolation, failure handling and adapter behavior. `package-provider-layer.selftest.mjs` verifies mixed distribution + Flatpak routing with a controlled executor double.

The dedicated Flatpak contract workflow and aggregate System Edition contract workflow run syntax and self-tests. Real System-image E2E must still verify a preconfigured signed remote, install/update/remove lifecycle, launch integration and rollback/recovery behavior before this path can be promoted from experimental to production.
