# SWIR System Catalog Trust State 0.1

## Purpose

`SystemCatalogTrustVerifier` already rejects invalid Ed25519 catalog signatures, stale metadata, digest mismatches, rollback and same-sequence equivocation. System Edition also needs that high-water mark to survive a process restart and reboot. `FileCatalogTrustStateStore` provides that durable Linux-side boundary without putting signing keys in the runtime.

## Production location and ownership

The production factory uses:

```text
/var/lib/swir/security/catalog-trust
```

The directory must be provisioned by the image/package installer as `root:root` mode `0700`. State entries are mode `0600`. The runtime does **not** silently create or relax this directory; a missing, symlinked, incorrectly owned or group/world-writable state root fails closed.

A base image can provision it with the distribution packaging equivalent of:

```text
install -d -o root -g root -m 0700 /var/lib/swir/security/catalog-trust
```

## Append-only high-water model

Accepted catalog state is stored as an immutable sequence entry:

```text
seq-0000000000000042-<catalog-sha256>.json
```

The highest valid sequence is the trusted high-water mark. Lower entries never replace a newer entry. This avoids a last-writer-wins rollback race between concurrent verifier processes. If two different signed catalog digests appear at the same highest sequence, reads fail closed as equivocation.

Each entry is bound to its filename by sequence and SHA-256 and records catalog version, signing key ID, generated/expiry timestamps and acceptance time. Reads use `O_NOFOLLOW` where available and validate regular-file type, ownership and permissions.

## Security properties

- no private signing key is stored here;
- no network fetch or package mutation happens in the state adapter;
- catalog sequence cannot move backward through `accept()`;
- same-sequence metadata replacement is rejected;
- concurrent different-digest acceptance becomes fail-closed equivocation rather than silent rollback;
- malformed or unsafe state entries fail closed;
- restart/reboot persistence is testable independently from the Store UI.

Root compromise is outside this boundary: a process already able to rewrite root-owned `0700/0600` security state can also compromise wider System Edition trust. Normal applications must never receive write access to this path.

## Integration gate

The AppImage provider remains experimental until System Edition has image-level provisioning of the official public catalog root and this root-owned state directory, followed by real image E2E. This component closes the durable anti-rollback-state gap; it does not by itself make the whole Package Provider layer production-complete.
