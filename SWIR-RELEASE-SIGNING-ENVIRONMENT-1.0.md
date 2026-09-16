# SWIR Release Signing Environment 1.0

This document defines the protected GitHub Actions boundary for SWIR OS Desktop and signed-catalog production signing. The release workflows intentionally reference one fixed environment name: `swir-release-signing`.

The environment is a security boundary, not a convenience setting. Production signing must not rely on repository-level private-key secrets alone.

## Required environment protection

Before a production Desktop or catalog release is signed, configure `swir-release-signing` in GitHub with all of the following controls:

1. allow deployments only from the `main` branch;
2. require at least one trusted reviewer for production signing;
3. prevent self-review when the repository plan/settings support it;
4. keep private signing keys as environment secrets, never as files committed to the repository;
5. protect `main` with review/status-check rules so an attacker cannot first replace the release workflow and then request environment approval;
6. keep the workflow token read-only during build/sign/verification; only the separate verified GitHub Release publication job may request `contents: write`;
7. review environment deployment history after every production release or key rotation.

Both secret-bearing jobs additionally fail closed unless the run targets the canonical `Swir/swir.github.io` repository and `refs/heads/main`. That guard is defense in depth and does not replace GitHub environment or branch protection.

## Environment secrets

Move the following values into `swir-release-signing` before production use:

| Secret | Purpose |
| --- | --- |
| `SWIR_DESKTOP_RELEASE_PRIVATE_KEY_PEM` | RSA private key for the signed Desktop update/release envelope |
| `SWIR_CATALOG_SIGNING_PRIVATE_KEY_PEM` | current Ed25519 private key for official catalog signing |
| `SWIR_CATALOG_SIGNING_PUBLIC_KEY_SHA256` | pinned SHA-256 fingerprint of the current public Ed25519 root |
| `SWIR_CATALOG_NEXT_PUBLIC_KEY_BASE64` | next public Ed25519 root during controlled rotation |
| `SWIR_CATALOG_NEXT_SIGNING_PUBLIC_KEY_SHA256` | pinned fingerprint of the next public root |
| `SWIR_CATALOG_ROTATION_CUTOVER_SEQUENCE` | first sequence at which the next root is active |
| `SWIR_CATALOG_CURRENT_RETIRE_AFTER_SEQUENCE` | final sequence at which the current root remains valid |

The private keys must exist only in the protected signing environment or the external key-management system that feeds it. Public roots and fingerprints may be shipped because they are verification material, not signing authority.

## Least-privilege workflow contract

`.github/workflows/desktop-release.yml` and `.github/workflows/signed-catalog-release.yml` follow these rules:

- secret values are step-scoped and are not placed in job-level `env`, so checkout/setup/upload actions do not inherit signing keys;
- third-party GitHub-maintained actions used by the release path are pinned to reviewed immutable commit SHAs rather than mutable major tags;
- checkout uses `persist-credentials: false` in signing jobs;
- the signing job requires the fixed `swir-release-signing` environment;
- non-main or non-canonical repository dispatches cannot enter the signing job;
- public release artifacts are checked for fail-closed catalog trust before upload/publish;
- temporary Desktop RSA key files are deleted in an `always()` cleanup step.

`scripts/validate-release-workflow-security.mjs` is the executable regression guard for these invariants. It is run by the signed-catalog and Desktop release-candidate/trust-chain contract workflows.

## Key rotation

For catalog root rotation:

1. provision the next *public* root and its fingerprint in the protected environment;
2. set a future cutover sequence and current-root retirement sequence;
3. release a Desktop build containing the overlapping current/next public trust roots;
4. move catalog signing to the next private key only when the configured sequence window permits it;
5. verify release health and anti-rollback state before removing the retired public root in a later release.

Never recover from an operational mistake by decreasing the catalog sequence or by widening an already-retired key window.

## Production readiness gate

This environment hardening is necessary but does not by itself complete the roadmap item `package signatures and integrity verification`. That item remains incomplete until a reviewed production public root is actually provisioned, the protected environment and branch rules are active, the official catalog signs the real shipping `.swirapp` digests, the production release is fail-closed with no legacy SHA path, and shipping install/update/restart/rollback E2E passes with that production authorization chain.
