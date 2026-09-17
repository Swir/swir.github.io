# SWIR fwupd / LVFS Integration 0.1

## Scope

This foundation gives SWIR Driver Center a **read-only** firmware discovery boundary backed by the base distribution's `fwupdmgr`. It does not install firmware and it does not grant applications direct D-Bus or root access.

The provider is pinned to the distribution-owned `/usr/bin/fwupdmgr`, verifies that the binary is a non-group/world-writable executable owned by the configured trusted UID, invokes it with `shell=false`, a minimal environment, timeout/output limits, and exposes only:

```text
fwupdmgr get-devices --json
fwupdmgr get-updates --json
```

`refresh`, `update`, `install`, configuration mutation and arbitrary command execution are deliberately absent from this surface.

## LVFS trust boundary

Only releases whose fwupd `RemoteId` is exactly `lvfs` become SWIR firmware candidates. Candidates are normalized to source class `fwupd-lvfs` with `repositoryId=lvfs`; direct firmware URLs from fwupd metadata are not exposed to Driver Center. Other remotes are counted but are not promoted as trusted LVFS candidates.

Discovery never means authorization. Every candidate carries `mutationAuthorized=false`. A future firmware transaction must separately bind:

1. active SWIR session/caller identity;
2. Driver Center plan and Hardware Catalog device identity;
3. fwupd/LVFS candidate identity and release;
4. Polkit authorization;
5. journal/recovery metadata and reboot/health handling;
6. a maintained base-distribution fwupd build and its security updates.

This separation is intentional. It avoids treating the fwupd daemon itself as permission for arbitrary application-initiated firmware changes.

## Driver source policy

This integration matches Architecture 0.1's allowed `fwupd-lvfs` source class. It does not introduce random HTTP downloads, scraped driver sites or Windows kernel drivers as Linux driver sources.

## Completion gate

The roadmap item **fwupd/LVFS firmware updates where supported** remains incomplete. It can only be marked complete after a privileged firmware transaction broker, reboot-safe journal/recovery path and real supported-hardware/System-image E2E exist. This 0.1 component intentionally covers inventory and candidate trust classification only.
