# SWIR Flatpak User Package Provider 0.1

Status: **implemented production-provisionable user-scope provider / version-aware SWIR rollback and broad System-image qualification pending**

This provider supplies the reviewed Flatpak path behind the common System Package Provider layer without weakening the privileged distribution-package path. The default System composition remains distribution-only; Flatpak is present only when the image explicitly provisions approved remote IDs.

## Scope

`system/packages/flatpak-user-package-provider.mjs` supports only:

- `linux-native` manifests using `swir.package.flatpak`;
- user-scoped Flatpak installs (`--user`);
- preconfigured, explicitly allowlisted Flatpak remote IDs;
- runtime confirmation that the selected remote is configured and has not disabled GPG verification;
- OSTree-style GPG-verified remotes only in this provider version; OCI remotes are rejected rather than silently treating different trust semantics as equivalent;
- `install`, `update` and `remove` operations;
- fixed `/usr/bin/flatpak` execution with `shell=false`, bounded execution/output and a minimal environment.

The provider does not add or edit remotes, accept remote URLs, run arbitrary commands, request root privileges, or treat Windows packages as native Linux applications.

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

## Runtime trust gate

The manifest allowlist is policy input, not proof that the current user actually has a trusted remote configured. Immediately before every mutation `GuardedFlatpakUserExecutor` performs a fail-closed runtime check:

1. `/usr/bin/flatpak` is inspected without following an attacker-selected path.
2. It must be a regular non-symlink file owned by root.
3. It must be executable and not group/world writable.
4. Its resolved path must still be exactly `/usr/bin/flatpak`.
5. The executor runs the read-only, documented Flatpak columns probe:

```text
/usr/bin/flatpak --user remotes --columns=name,options
```

6. The requested remote must be present in that output.
7. The remote must not contain the `disabled` option.
8. The remote must not contain the `no-gpg-verify` option.
9. OCI remotes are rejected by this 0.1 path because its trust contract explicitly requires the OSTree/GPG verification model.

Flatpak exposes disabled GPG verification through the `no-gpg-verify` remote option. SWIR therefore checks the supported `options` column instead of inventing a non-existent `gpg-verify` column. An empty options field is valid and is handled without trimming away the trailing tab separator.

A missing Flatpak executable, unsafe ownership/mode, symlinked executable, missing or disabled remote, failed probe, `no-gpg-verify`, or OCI trust mode blocks the mutation before the operation command is spawned.

## Execution boundary

Plans use exact reviewed argv templates:

```text
/usr/bin/flatpak --user --noninteractive install --or-update REMOTE APP_ID
/usr/bin/flatpak --user --noninteractive update APP_ID
/usr/bin/flatpak --user --noninteractive uninstall APP_ID
```

Before execution the guarded executor revalidates provider, operation, scope, trust policy, executable path, actual remote trust and the full argument vector. A caller cannot append `--command`, replace the binary, switch to system scope or redirect the operation to another remote.

Flatpak/OSTree supplies the native atomic transaction mechanism for this user-scope path. SWIR does not yet expose a separately versioned committed-rollback API for Flatpak, so `versionAwareRollbackImplemented` remains false rather than claiming functionality that has not been implemented.

## Common layer integration

`createSystemPackageProviderLayer()` is distribution-only by default. The same production factory can provision `swir.package.flatpak` only when `flatpakAllowedRemotes` contains one or more explicit remote IDs. If no remote policy is supplied, the provider remains `not-provisioned` and package requests fail closed.

The older `createExperimentalSystemPackageProviderLayer()` name remains only as a compatibility alias and applies the identical production composition rules; it no longer represents a weaker execution path.

## Verification

`flatpak-user-package-provider.selftest.mjs` verifies:

- plan templates and complete argv tamper rejection;
- user-scope and manifest trust enforcement;
- root-owned fixed-binary checks;
- rejection of unsafe binary owner/mode;
- configured-remote presence;
- empty-options parsing without false negatives;
- rejection of `no-gpg-verify`, disabled and OCI remotes;
- fixed environment and `shell=false`;
- failed trust-probe and failed mutation handling.

`package-provider-layer.selftest.mjs` verifies default fail-closed composition plus reviewed distribution + Flatpak + signed AppImage production composition. The dedicated Flatpak contract and aggregate System Edition contract rerun these guards together.

This provider does not claim that every Flatpak or third-party remote is suitable for SWIR OS. System-image policy must still decide which remotes are provisioned, and broader launch/sandbox/update/rollback qualification remains a separate release-quality gate.