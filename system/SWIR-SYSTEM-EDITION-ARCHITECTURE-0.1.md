# SWIR OS System Edition — Architecture 0.1

## Purpose

System Edition is the future bootable SWIR OS. It is **not** a custom kernel project and it must not pretend that Windows binaries or Windows kernel drivers execute natively on Linux.

The target is a hybrid operating system built around a proven Linux base while preserving the portable SWIR application/runtime contracts used by Web and Desktop Edition.

```text
SWIR Shell / SWIR Apps
        |
        v
SwirAppSDK + SwirRuntime
        |
        +----------------------+----------------------+
        |                      |                      |
        v                      v                      v
 Linux native apps       Windows compatibility    Web/SWIR apps
 .deb/.rpm/etc.          Wine / Proton prefix     SWIR package/runtime
 Flatpak/AppImage        compatibility profile    sandbox/capabilities
        |                      |                      |
        +----------- SWIR Package / Store Layer -----+
                               |
                               v
                    Linux services + kernel
```

## Base-system rules

System Edition must:

- use a maintained Linux kernel and a selected maintained base distribution;
- consume kernel drivers from in-tree Linux support first;
- consume firmware from the base distribution's `linux-firmware` packaging;
- use `fwupd` / LVFS for device firmware where supported;
- allow explicitly configured official vendor repositories for exceptional proprietary components such as GPU modules;
- never scrape or install random binary drivers from unverified download sites;
- keep system package installation behind an authenticated privileged service rather than shelling out from untrusted app UI;
- support rollback/recovery metadata for package, driver and firmware changes.

The exact base distribution remains a release-engineering choice and must be selected only after installer, update, Secure Boot, hardware coverage and long-term maintenance tests.

## Application execution classes

Every executable package presented by SWIR Store is assigned exactly one execution class.

### `swir-web`

Portable SWIR application executed through SWIR App SDK and Runtime contracts.

### `linux-native`

Native Linux software installed by an approved provider. Initial provider abstraction covers base-distribution packages and future Flatpak/AppImage adapters.

### `windows-compat`

Windows user-space application executed through Wine/Proton or another explicitly approved compatibility provider. Each application receives a managed compatibility prefix/profile.

Windows compatibility is a user-space execution layer. It is **not** permission to load Windows kernel drivers into Linux.

## Package provider contract

The common Store/Package layer owns policy while providers own platform-specific mechanics.

Required provider operations:

```text
probe()
resolve(package)
planInstall(package)
install(plan)
planUpdate(package)
update(plan)
planRemove(package)
remove(plan)
rollback(transaction)
diagnostics()
```

Provider implementations must return structured plans before privileged mutation. Plans expose source, signatures/trust state, downloads, disk impact, permissions/integrations, restart requirement and rollback capability.

Initial provider IDs reserved by Architecture 0.1:

```text
swir.package.web
swir.package.system
swir.package.flatpak
swir.package.appimage
swir.compat.wine
swir.compat.proton
```

A provider being reserved does not mean it is implemented or enabled.

## Windows compatibility service

`SWIR Compatibility Service` is the future broker for Windows applications. It owns:

- Wine/Proton runtime discovery and approved runtime versions;
- one managed prefix per application/profile by default;
- architecture (`win64`/`win32`) metadata;
- environment allowlists;
- launch command construction;
- filesystem integration mediated through SWIR permissions;
- optional DXVK/VKD3D/runtime components only from approved package sources;
- per-app diagnostics and logs;
- prefix snapshot/reset/migration;
- compatibility overrides kept as data, not hard-coded UI logic.

The service must not expose arbitrary root command execution to applications.

## Hardware Service and Driver Center

System Edition introduces two cooperating components:

```text
Hardware Service
  -> enumerate PCI / USB / platform devices
  -> normalize hardware IDs
  -> report kernel module / firmware / driver package state
  -> publish non-secret diagnostics

SWIR Driver Center
  -> consume Hardware Service inventory
  -> match Hardware Catalog rules
  -> show current driver / firmware source
  -> show trusted update candidates
  -> request privileged install/update/rollback transaction
```

### Hardware Catalog mapping

Catalog entries map stable identifiers to supported Linux components, for example:

```text
PCI/USB ID
   -> kernel module
   -> optional firmware package/file
   -> optional distribution driver package
   -> optional fwupd/LVFS path
   -> optional approved vendor repository
```

A catalog entry must identify its source class. Unknown hardware can be reported diagnostically but must never trigger an untrusted automatic download.

## Driver source policy

Allowed source classes in Architecture 0.1:

- `kernel-in-tree`
- `linux-firmware`
- `distribution-repository`
- `fwupd-lvfs`
- `vendor-official-repository`

Explicitly forbidden as automatic driver sources:

- arbitrary HTTP/HTTPS binary URLs;
- community file mirrors without package trust integration;
- Windows `.sys`/installer packages as a generic Linux driver solution;
- executables downloaded from search results or scraped driver sites.

Vendor repository exceptions require a catalog entry, an allowlisted repository identity and normal package signature verification.

## Hardware transaction model

Driver/firmware mutations follow a transaction lifecycle analogous to Desktop Edition updates:

```text
planned
  -> verified
  -> applying
  -> awaiting-reboot (optional)
  -> health-check
  -> committed
       or
  -> rollback-pending
  -> rolled-back / recovery-required
```

A health check can include module load state, device presence, firmware result, display/network availability and boot-success markers. A driver rollback must be planned before mutation whenever the underlying package/provider supports it.

## Native adapter targets

System Native Host should progressively implement `swir.runtime/1.0` using Linux services:

```text
filesystem -> Linux filesystem + capability broker
processes  -> procfs/system service broker
clipboard  -> Wayland/X11 desktop integration
tray       -> desktop-status integration where available
network    -> NetworkManager adapter
updater    -> SWIR update transaction service
hardware   -> Hardware Service contract (new privileged surface)
packages   -> SWIR Package provider service
compat     -> Wine/Proton Compatibility Service
```

New privileged surfaces stay fail-closed until their broker and permission model exist.

## Security boundary

- UI and app JavaScript never receive unrestricted root access.
- Privileged services validate caller identity, package identity, permission grant and operation scope.
- Raw device access is not a general application capability.
- Driver, firmware and package sources require explicit trust policy.
- Compatibility prefixes are application-scoped and do not imply host filesystem access.
- System updates, driver changes and firmware changes must be journaled.
- Recovery remains available when a mutation can affect boot, display, storage or networking.

## Delivery sequence

1. Keep Desktop Edition update/recovery work green and stabilize native adapter contracts.
2. Freeze portable provider/hardware data contracts in Web/Desktop code without exposing fake privileged behavior.
3. Select a Linux base using automated hardware/installer/update tests.
4. Implement read-only Hardware Service inventory and NetworkManager/native filesystem adapters.
5. Implement privileged Package Service with distribution provider and transaction journal.
6. Add Driver Center backed only by trusted source classes.
7. Add Wine compatibility provider and managed prefixes for Windows user applications.
8. Add Flatpak provider; evaluate AppImage integration with explicit sandbox/update policy.
9. Build installer, boot/session integration and recovery environment.
10. Only after hardware/update/recovery gates pass, produce System Edition preview images.

## Non-goals for Architecture 0.1

- replacing the Linux kernel;
- loading generic Windows kernel drivers;
- downloading drivers from arbitrary websites;
- silently installing privileged packages from app code;
- claiming all Windows applications will work;
- selecting a base distribution without test evidence.
