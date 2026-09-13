# SWIR Package Transactions 1.0

Schema: `swir.package-transaction/1.0`

SWIR Package Core journals mutating package operations before changing installed state. The journal is edition-neutral and is intended to survive later migration from the Web package store to the Desktop `.swirapp` installer and System package providers.

## Transaction states

```text
PREPARED -> APPLYING -> COMMITTED
                    \-> ROLLED_BACK
                    \-> ROLLBACK_FAILED
```

A mutation is not allowed to begin unless transaction journal storage is available. The current Web implementation stores a bounded history through `SwirPlatform.storage`; native editions should map the same records to durable native transaction storage.

## Covered operations

- fresh package install,
- package update over an installed version,
- package removal,
- automatic rollback after a partial mutation failure,
- explicit user-approved rollback of a committed install/update/remove operation.

Each record includes the package id, action, source and target versions, timestamps, status and rollback metadata. Rollback metadata contains the previous installed package snapshot, the previous permission state and the exact permission names touched by the transaction.

## Safety properties

Package state and permissions are treated as one logical mutation. If applying permissions fails after the package record has already changed, the pipeline restores the previous package record (or removes a newly installed package) and restores the prior permission values. A rollback failure is never hidden: the journal enters `ROLLBACK_FAILED` and preserves both the original error and rollback error.

Manual rollback requires explicit approval. Transaction history is bounded to 50 records in the current Web implementation to avoid unbounded client storage growth.

## API

`SwirInstallPipeline` 1.2 exposes:

```text
prepare(manifest, options)
install(manifest, options)
update(manifest, options)
remove(manifest, options)
rollback(transactionId, { approved: true })
transactions({ packageId? })
info()
```

`update()` requires an already installed version and reuses the same integrity, trust, dependency and permission gates as a normal install.

## Desktop/System migration

Desktop Edition should keep the transaction contract while replacing the Web package mutation backend with the native `.swirapp` installer. System Edition can extend the same journal with provider-specific steps for distribution packages, Flatpak/AppImage policy, Wine/Proton profiles, firmware and drivers. Privileged native providers should add filesystem/package-manager snapshots or equivalent recovery metadata rather than weakening this contract.
