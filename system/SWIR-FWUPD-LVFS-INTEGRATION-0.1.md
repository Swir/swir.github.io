# SWIR fwupd / LVFS Integration 0.1

## Scope

This foundation gives SWIR Driver Center a **read-only** firmware discovery boundary backed by the base distribution's `fwupdmgr`. It does not install firmware and it does not grant applications direct D-Bus or root access.

The provider is pinned to the distribution-owned `/usr/bin/fwupdmgr`, verifies that the binary is a non-group/world-writable executable owned by the configured trusted UID, invokes it with `shell=false`, a minimal environment, timeout/output limits, and exposes only:

```text
fwupdmgr get-devices --json
fwupdmgr get-updates --json
```

`refresh`, `update`, `install`, configuration mutation and arbitrary command execution remain absent from this **discovery** surface.

## LVFS trust boundary

Only releases whose fwupd `RemoteId` is exactly `lvfs` become SWIR firmware candidates. Candidates are normalized to source class `fwupd-lvfs` with `repositoryId=lvfs`; direct firmware URLs from fwupd metadata are not exposed to Driver Center. Other remotes are counted but are not promoted as trusted LVFS candidates.

Discovery never means authorization. Every candidate carries `mutationAuthorized=false`. The separate firmware transaction broker must bind:

1. active SWIR session/caller identity;
2. Driver Center plan and Hardware Catalog device identity;
3. fwupd/LVFS candidate identity and release;
4. Polkit authorization;
5. journal/recovery metadata and reboot/health handling;
6. a maintained base-distribution fwupd build and its security updates.

This separation is intentional. It avoids treating the fwupd daemon itself as permission for arbitrary application-initiated firmware changes.

## Mutation companion

`system/firmware/fwupd-firmware-transaction-service.mjs` is the privileged mutation companion for this read-only discovery service. It accepts only normalized LVFS candidates, creates a digest-bound update plan, obtains a dedicated Polkit grant, persists a private journal **before** invoking the guarded executor and then re-reads this discovery service to verify the result.

The executor is intentionally narrower than the discovery client and only accepts the fixed per-device template:

```text
/usr/bin/fwupdmgr --assume-yes --no-reboot-check update <device-id>
```

A reboot-staged update records the Linux boot identity and can only be reconciled after that identity changes. Post-boot reconciliation re-reads fwupd inventory and commits only when the target version is observed. Generic automatic firmware rollback is not claimed.

See `SWIR-FIRMWARE-TRANSACTION-BROKER-0.1.md` for the transaction and recovery contract.

## Driver source policy

This integration matches Architecture 0.1's allowed `fwupd-lvfs` source class. It does not introduce random HTTP downloads, scraped driver sites or Windows kernel drivers as Linux driver sources.

## Completion gate

The roadmap item **fwupd/LVFS firmware updates where supported** remains incomplete. Read-only discovery, a guarded transaction broker, a reboot-aware journal and boot-identity-bound post-boot reconciliation are now implemented and contract-tested, but the checkbox still requires real supported-hardware/System-image E2E and recovery behavior verified across representative firmware classes. A software fixture is not proof that a physical device can be safely flashed or rolled back.
