# SWIR OS — Architecture Roadmap

## Project direction

SWIR OS is designed in three editions sharing one application model and platform contracts:

1. **SWIR OS Web Edition** — current `swir.github.io` prototype and design laboratory.
2. **SWIR OS Desktop Edition** — future native desktop build with real files, processes, networking and OS integrations.
3. **SWIR OS System Edition** — future bootable Linux-based system with the SWIR shell, services, accounts and applications.

```text
SWIR Application
      |
      v
SWIR App SDK
      |
      v
SWIR Platform API
      |
      +------------------+------------------+
      |                  |                  |
      v                  v                  v
 Web Adapter        Desktop Adapter       System Adapter
 IndexedDB          Native filesystem     Linux filesystem
 Browser APIs       Native processes      Linux processes
 Local profiles     Native accounts       Linux accounts
 Browser network    Native adapters       NetworkManager
 PWA cache          Native packages       SWIR packages
```

The UI should not need to know which edition it runs on.

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

Web Edition currently maps these to browser APIs, IndexedDB/localStorage and the SWIR window manager. Desktop/System editions will replace the adapters with native implementations.

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

Browsers do not allow arbitrary scanning/connecting to real Wi-Fi networks. Future native editions can map the same UI to native networking / NetworkManager.

```text
SWIR Network Center
        |
        v
Network Adapter Contract
        |
   +----+----------------+
   |                     |
Desktop               System
Native API            NetworkManager
```

---

## App SDK & Package Core — 1.6

SWIR OS 1.6 introduces **SWIR App SDK 1.0** and **SWIR App Package 1.0**.

Official package schema:

```text
swir.app/1.0
```

The specification lives in `SWIR-APP-PACKAGE-1.0.md`.

### Web Edition install lifecycle

```text
SWIR Store 2.0
      |
      v
Package manifest
      |
      v
Permission review
      |
      v
SwirPlatform.packages.install()
      |
      +--> SwirPlatform.permissions
      +--> launcher registry mirror
      |
      v
Apply / rebuild shell registry
```

Web Edition registers package state and permissions while the actual HTML/JS source ships with the static SWIR OS build.

Desktop/System target lifecycle:

```text
DOWNLOAD .swirapp
      -> VERIFY MANIFEST
      -> VERIFY SIGNATURE
      -> CHECK COMPATIBILITY
      -> DISPLAY PERMISSIONS
      -> INSTALL PAYLOAD
      -> REGISTER APP / FILE TYPES
      -> LAUNCH
```

### Initial installable package catalog

- `swir.code` — SWIR Code
- `swir.image-studio` — Image Studio
- `swir.archive` — Archive Manager
- `swir.pdf-viewer` — PDF Viewer
- `swir.chat` — SWIR Chat

Core system components such as Store, File Explorer, Settings, User Manager, Device Manager, Network Center, Task Manager, Services, Update Center, Platform Control and Terminal stay outside the uninstallable catalog.

### Initial permission vocabulary

```text
files.read
files.write
clipboard
downloads
network
storage
identity.basic
notifications
```

A manifest requesting a permission does not automatically grant authority. Platform adapters are responsible for enforcing granted capabilities.

---

## SWIR Services

Current Web service/status model includes:

- Window Manager
- Device Service
- Network Service
- Storage Service
- Identity Service
- Session Service
- Chat Service
- Cache Service
- Update Service
- Permission Service

Desktop/System editions can map these to native services/daemons.

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
- **SWIR App SDK 1.0**
- **SWIR App Package 1.0**
- **SWIR Store 2.0 install/remove lifecycle**

### Next Web Edition work

- app-specific data directories
- file associations and “Open with”
- package update/version comparison
- package dependency model
- notification API for applications
- widgets as installable packages
- application developer template / SDK examples
- signed catalog metadata prototype

### Desktop Edition 2.x

Planned:

- lightweight native runtime
- native filesystem adapter
- native device/network adapters
- native account/session backend
- process/service manager
- native clipboard and tray
- global shortcuts and file associations
- `.swirapp` payload installer/updater
- sandboxed permissions

### System Edition 3.x

Planned:

- proven Linux base/kernel
- bootable ISO
- SWIR boot splash and login/session manager
- SWIR desktop shell
- NetworkManager/hardware integration
- system services
- package manager/updater
- filesystem integration
- recovery mode

---

## Development rule

Applications should prefer **SwirAppSDK** and **SwirPlatform** over direct edition-specific APIs. Anything that cannot yet be represented by a portable contract should stay behind a replaceable adapter until that contract is formalized.
