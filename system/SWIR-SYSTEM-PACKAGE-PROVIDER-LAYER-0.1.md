# SWIR System Package Provider Layer 0.1

Status: **implemented production-provisionable common routing / default fail-closed composition**

`system/packages/package-provider-layer.mjs` is the System Edition routing boundary above concrete Linux package providers. Store/Update Center code receives one stable surface for planning, executing and recovering native Linux package operations without invoking package managers or arbitrary commands directly.

## Production composition

```text
System Store / Update Center
        |
        v
SystemPackageProviderLayer
        |
        +--> swir.package.system   -> DistributionPackageStackAdapter
        |                             -> repository trust + authorization
        |                             -> snapshot + durable journal
        |                             -> guarded privileged executor + health
        |
        +--> swir.package.flatpak  -> optional user-scope adapter
        |                             -> explicit allowlisted remote IDs only
        |                             -> trusted /usr/bin/flatpak
        |                             -> configured remote + GPG verification rechecked
        |                             -> fixed argv, shell=false
        |
        +--> swir.package.appimage -> optional managed-import adapter
                                      -> native Ed25519 signed-catalog authorization
                                      -> exact version/sourceRef/SHA-256 binding
                                      -> managed per-user root + journal + crash recovery
                                      -> no network acquisition
```

`createSystemPackageProviderLayer()` always requires the distribution stack. With no optional configuration it remains distribution-only and therefore preserves the previous fail-closed default.

Flatpak becomes available only when one or more explicit `flatpakAllowedRemotes` are provisioned. AppImage becomes available only when **both** an explicit managed `appImageInstallRoot` and a host-provisioned `SystemCatalogTrustVerifier` are supplied. Supplying only one AppImage requirement fails closed. The common layer still exposes no caller-controlled adapter registration.

`createExperimentalSystemPackageProviderLayer()` remains as a compatibility alias for older callers, but it now uses exactly the same production composition rules and cannot weaken trust requirements.

## Common contract

The router accepts `swir.package-provider/0.2` manifests only when:

- `targetEditions` contains `system`;
- `executionClass` is `linux-native`;
- the provider is one of the reviewed distribution, Flatpak or AppImage providers;
- the operation is `install`, `update` or `remove`.

The router independently checks provider and operation identity returned by a provider plan. Windows compatibility remains behind the separate Wine/Proton service and is intentionally rejected by this Linux-native layer.

## Flatpak runtime trust boundary

A manifest allowlist alone is not sufficient for a production mutation. Immediately before every Flatpak operation the guarded executor now verifies both the executable and the configured remote:

1. `/usr/bin/flatpak` must be a regular non-symlink file.
2. It must be root-owned, executable and not group/world writable.
3. Its real path must remain exactly `/usr/bin/flatpak`.
4. The selected remote must be one of the image-provisioned allowlisted remote IDs.
5. A read-only `flatpak --user remotes --columns=name,gpg-verify` probe must prove that the remote is actually configured for the current user.
6. That runtime remote must report GPG verification enabled.
7. The mutation argv is regenerated/revalidated against the reviewed operation template and runs with `shell=false`, a bounded timeout/output buffer and a fixed environment.

No remote URL is accepted by the package manifest or operation plan. The provider does not add or edit remotes. Flatpak remains user scoped in 0.1 and relies on Flatpak/OSTree atomicity; SWIR does not yet claim a separate version-aware committed rollback API for Flatpak.

## AppImage trust boundary

AppImage install/update cannot be authorized with a caller-selected boolean. The native System catalog verifier reuses `swir.catalog-signature/1.0` / `catalog:official` Ed25519 trust, recomputes the canonical catalog SHA-256, validates freshness and high-water anti-rollback state, rejects same-sequence equivocation, verifies the signature and binds exact package id/version/sourceRef/digest from `artifacts.system.appimage` to the manifest.

The verifier emits an opaque in-process authorization branded by the verifier module. The managed executor rejects lookalike objects, so direct callers cannot forge trust by reproducing visible authorization fields.

Install/update hash the local artifact before mutation and the copied temporary payload again before atomic rename. A prepared transaction journal is written first; existing payloads are moved to a managed recovery backup before update/remove. Recovery validates journal identity and all target/backup/temp paths against managed roots before filesystem mutation. Symlink managed targets are rejected.

AppImage remains explicitly non-sandboxed at the format level. Execution must continue through SWIR permission and native-launch policy. Committed user-facing AppImage rollback is not claimed yet; crash recovery is implemented.

## Security invariants

- no shell or child-process execution in the common routing layer;
- no arbitrary provider registration or caller-provided provider adapter in production composition;
- optional providers remain absent unless their explicit safe provisioning inputs exist;
- distribution mutation stays behind the existing repository-trust, authorization, snapshot, journal and guarded privileged stack;
- Flatpak checks fixed-binary provenance and actual configured-remote GPG policy immediately before execution;
- Flatpak never accepts a remote URL from Store/UI metadata;
- AppImage has no built-in network acquisition and requires native cryptographic catalog authorization plus exact digest binding;
- AppImage does not claim sandbox isolation that the format does not provide;
- Windows compatibility remains a separate managed Wine/Proton execution class;
- provider-specific recovery remains provider-owned rather than synthesized by Store UI.

## Verification

`package-provider-layer.selftest.mjs` covers default fail-closed behavior plus production composition of all three reviewed providers using a real ephemeral Ed25519 catalog authorization for AppImage.

`flatpak-user-package-provider.selftest.mjs` covers manifest/argv enforcement, untrusted Flatpak binary rejection, missing remote rejection, disabled remote GPG verification, failed trust probe, fixed environment, `shell=false` and mutation failure behavior.

`appimage-user-package-provider.selftest.mjs` covers cryptographic trust, anti-rollback, digest binding, install/update/remove, forged-authorization rejection and malicious-journal path rejection. `system/e2e/appimage-native-execution.selftest.mjs` verifies signed catalog authorization followed by managed install and trusted native launch on Linux.

The dedicated Package Provider workflow reruns common composition, Flatpak/AppImage provider contracts and the distribution package stack together, so promotion of an optional provider cannot silently bypass the existing distribution path.

## Roadmap meaning

This implementation supplies a production composition contract for distribution packages plus explicitly provisioned Flatpak/AppImage providers while preserving a distribution-only default and fail-closed trust boundaries. It does **not** by itself complete the separate roadmap items for a dependency-aware system updater, fwupd mutation, vendor repositories, cross-domain transaction recovery or filesystem recovery mode. Those remain independent System Edition gates.