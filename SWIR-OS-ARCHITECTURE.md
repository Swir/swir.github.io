# SWIR OS — Architecture Roadmap

## Project direction

SWIR OS is designed in three editions sharing one application model and platform contracts:

1. **SWIR OS Web Edition** — current `swir.github.io` prototype and design laboratory.
2. **SWIR OS Desktop Edition** — native desktop build with real files, processes, networking and OS integrations.
3. **SWIR OS System Edition** — future bootable Linux-based system with the SWIR shell, services, accounts, native Linux applications and a managed Windows compatibility layer.

```text
SWIR Application
      |
      v
SWIR App SDK
      |
      v
SWIR Platform API / SwirRuntime
      |
      +------------------+------------------+
      |                  |                  |
      v                  v                  v
 Web Adapter        Desktop Adapter       System Adapter
 IndexedDB          Native filesystem     Linux filesystem
 Browser APIs       Native processes      Linux processes
 Local profiles     Native accounts       Linux accounts
 Browser network    Native adapters       NetworkManager
 PWA cache          Native packages       Linux/SWIR packages
```

The UI should not need to know which edition it runs on. Privileged behavior remains behind replaceable brokers and permission checks.

---

## SWIR Platform API 2

Platform API 1 arrived in SWIR OS 1.3. Platform API 2 arrived in 1.4 and added Identity, Sessions and Settings.

Main surfaces:

```text
SwirPlatform.storage
SwirPlatform.settings
SwirPlatform.identity
SwirPlatform.files
SwirPlatform.clipboard
SwirPlatform.permissions
SwirPlatform.packages
SwirPlatform.processes
SwirPlatform.system
```

Web Edition currently maps these to browser APIs, IndexedDB/localStorage and the SWIR window manager. Desktop/System editions replace adapters with native implementations while preserving portable call shapes where practical.

---

## Identity & Session Core — 1.4

Web Edition provides local profiles, active-user selection, roles, optional local PIN, lock state and First Boot/OOBE.

The Web PIN is only a convenience lock. Desktop/System editions must map identity and authentication to native account/session security.

---

## Device & Network Core — 1.5

### Device Manager

Web Edition exposes the device information browsers make available, including logical CPU count, approximate memory, screen/viewport, storage estimate, battery when supported and connection telemetry.

### Network Center

Web Edition exposes online/offline state and connection metrics when supported, plus portable SWIR network profiles.

Browsers do not allow arbitrary scanning/connecting to real Wi-Fi networks. Native editions map the same user model to native adapters; System Edition targets a NetworkManager-backed service.

---

## App SDK & Package Core — 1.6

SWIR OS 1.6 introduced **SWIR App SDK 1.0** and **SWIR App Package 1.0** using schema `swir.app/1.0`.

The specification lives in `SWIR-APP-PACKAGE-1.0.md`.

---

## Files, Associations, Notifications & Dependency Core — 1.7

SWIR OS 1.7 reaches **SWIR App SDK 1.3**. The 1.7 line adds portable file-association, app-data, application-notification and package dependency contracts.

### File handoff

```text
SWIR File Explorer
       |
       v
extension / MIME lookup
       |
       v
SWIR File Association Service
       |
       +--> saved default handler
       +--> first installed compatible package
       |
       v
SwirAppSDK.files.open(...)
       |
       v
application receives SWIR_OPEN_FILE payload
```

Initial handlers:

```text
swir.code          -> .txt .html .htm .css .js .json .md .log
swir.image-studio  -> .png .jpg .jpeg .webp .gif
swir.archive       -> .zip
swir.pdf-viewer    -> .pdf
```

### App Data

Every installable package can declare a logical private data path such as:

```text
SWIR://APPDATA/CODE
SWIR://APPDATA/IMAGE
SWIR://APPDATA/ARCHIVE
SWIR://APPDATA/PDF
SWIR://APPDATA/CHAT
```

Web Edition maps this to namespaced SWIR Platform storage. Desktop Edition maps it to a native application-data directory. System Edition maps it to a native per-user/per-application filesystem location.

### Application Notification Service

Applications with the `notifications` permission can publish portable notifications through the SDK. The Web Edition maps them to the SWIR shell toast/notification center and keeps a bounded application notification history.

```text
SWIR App
   |
   v
SwirAppSDK.notifications.send(appId, options)
   |
   +--> package installed check
   +--> manifest permission declaration
   +--> granted permission check
   |
   v
SWIR Notification Service
```

### Package Dependency Core

The package resolver implements `swir.dependencies/1.0` and is intentionally independent from the web Store UI.

```text
SWIR App Package
      |
      v
SWIR Package Resolver
      |
      +--> min SWIR OS version
      +--> min App SDK version
      +--> min Platform API
      +--> supported editions
      +--> required package versions
      +--> optional dependency warnings
      |
      v
INSTALL / REMOVE PLAN
```

Supported portable package APIs:

```text
SwirAppSDK.packages.check(id)
SwirAppSDK.packages.planInstall(id)
SwirAppSDK.packages.planRemove(id)
SwirAppSDK.packages.audit()
SwirAppSDK.packages.runtime()
SwirAppSDK.packages.compareVersions(a, b)
```

**SWIR Store 2.2** enforces resolver results before install and remove actions. A package that requires a newer OS/SDK/API, unsupported edition, or missing dependency is blocked. Removal is blocked if an installed dependent package would break.

Desktop/System editions can reuse the resolver before native payload download/unpack, signature verification and service/file-association registration.

### SDK additions available in 1.7

```text
SwirAppSDK.files.*
SwirAppSDK.notifications.*
SwirAppSDK.packages.*
```

---

## SWIR Services

Current Web service/status model includes:

- Window Manager
- Device Service
- Network Service
- Storage Service
- Identity Service
- Session Service
- Package Service
- **Package Resolver**
- File Association Service
- App Data Service
- Notification Service
- Chat Service
- Cache Service
- Update Service
- Permission Service

Desktop/System editions map these to native services/daemons where privileged or persistent behavior is required.

---

## SWIR Chat service

```text
SWIR Chat client
      |
      v
SWIR Chat API
      |
      v
MySQL / MariaDB
```

The Web client lives in SWIR OS. Chat Server Kit supplies the downloadable PHP backend for separate hosting. Future transport can move from polling to WebSockets without replacing the client application model.

---

## Hybrid System Edition foundation

System Edition is deliberately Linux-based and hybrid rather than pretending that every foreign binary is native.

### Execution classes

```text
swir-web       -> SWIR App SDK / runtime
linux-native   -> approved Linux package provider
windows-compat -> Wine / Proton managed compatibility profile
```

Windows user applications are planned through Wine/Proton-style compatibility prefixes. Windows kernel drivers are not a general Linux hardware solution and must not be treated as one.

### Common Store / Package layer

The future common provider layer can resolve and plan installation across:

```text
SWIR packages
base-distribution packages
Flatpak
AppImage (after explicit sandbox/update policy)
Wine compatibility profiles
Proton compatibility profiles
```

Provider mechanics remain separate from Store UI policy. Privileged mutations require a structured plan, trusted source policy and transaction journal.

### Hardware / Driver architecture

System Edition adds a read-only-first **Hardware Service** and a **SWIR Driver Center**. Hardware inventory normalizes PCI/USB IDs and maps devices through the Hardware Catalog to kernel modules, firmware, packages and update sources.

Trusted driver/firmware source classes are limited to:

```text
kernel-in-tree
linux-firmware
distribution-repository
fwupd-lvfs
vendor-official-repository
```

Unknown hardware may be diagnosed but must not trigger arbitrary automatic downloads. Firmware and driver mutations require a privileged transaction with rollback/recovery metadata where supported.

The detailed foundation and machine-readable contract schemas live under `system/`, beginning with `system/SWIR-SYSTEM-EDITION-ARCHITECTURE-0.1.md`.

---

## Version roadmap

### Web Edition 1.x — implemented foundation

- desktop shell / window manager
- launcher / taskbar
- First Boot / OOBE
- Identity & Session Core
- Device Manager
- Network Center
- System Settings
- File Explorer / virtual filesystem
- Notes / Calculator / Player / Matrix
- SWIR Chat + downloadable backend
- Task Manager / SWIR Services
- permissions / clipboard / Update Center
- **SWIR App SDK 1.3**
- **SWIR App Package 1.0**
- **SWIR Store 2.2 dependency-aware lifecycle**
- **package compatibility + dependency resolver**
- **file associations / Default Apps / Open With**
- **App Data namespaces**
- **permission-aware application notification API**

### Next Web Edition work

- signed catalog metadata prototype
- widgets as installable packages
- application developer template / SDK examples
- larger binary/file storage on IndexedDB instead of localStorage mirror
- package update transactions / rollback metadata
- native-ready notification actions and persistence adapter

### Desktop Edition 2.x

Active direction:

- lightweight native runtime
- native filesystem adapter
- native device/network adapters
- native account/session backend
- process/service manager
- native clipboard and tray
- global shortcuts and native file associations
- `.swirapp` payload installer/updater
- package dependency resolver shared with Web Edition
- package signatures and integrity verification
- sandboxed permissions
- native notification adapter
- guarded update activation, health proof, rollback and restart handoff

### System Edition 3.x

Planned:

- maintained Linux base/kernel and bootable image
- SWIR boot splash and login/session manager
- SWIR desktop shell
- NetworkManager integration
- native Linux application execution
- common Package Provider layer for distribution packages and later Flatpak/AppImage
- managed Wine/Proton compatibility service for Windows user applications
- Hardware Service with PCI/USB inventory
- SWIR Driver Center / Hardware Catalog
- in-tree Linux drivers + linux-firmware as primary hardware path
- fwupd/LVFS firmware updates where supported
- allowlisted official vendor repositories for exceptional proprietary components
- dependency-aware system package manager/updater
- journaled driver/firmware/package transactions
- filesystem integration and recovery mode

---

## Development rule

Applications should prefer **SwirAppSDK**, **SwirPlatform** and **SwirRuntime** over direct edition-specific APIs. Anything that cannot yet be represented by a portable contract stays behind a replaceable adapter until that contract is formalized. Privileged operations remain fail-closed until the corresponding broker, identity binding, permission model and recovery path exist.
