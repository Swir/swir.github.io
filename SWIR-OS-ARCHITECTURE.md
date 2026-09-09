# SWIR OS — Architecture Roadmap

## Project direction

SWIR OS is being designed in three editions that share the same UX, application model and platform contracts:

1. **SWIR OS Web Edition** — current `swir.github.io` prototype and design laboratory.
2. **SWIR OS Desktop Edition** — future native desktop build with access to real files, processes, clipboard, networking and OS integrations.
3. **SWIR OS System Edition** — future bootable Linux-based operating system with the SWIR shell, services, accounts and applications.

The goal is to reuse application UI and business logic between editions instead of rewriting everything.

---

## Core architecture

```text
SWIR Application
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

Applications should call `window.SwirPlatform` and edition adapters instead of reaching directly into browser-only APIs whenever possible.

---

## SWIR Platform API 2

Platform API 1 was introduced in **SWIR OS 1.3**. Platform API 2 arrived with **SWIR OS 1.4** and added Identity, Sessions and Settings while preserving the previous API surface.

### Metadata

- `SwirPlatform.meta`
- Version / edition / build / Platform API information.

### Storage

- `SwirPlatform.storage.get(key)`
- `SwirPlatform.storage.set(key, value)`
- `SwirPlatform.storage.remove(key)`

Current Web adapter: IndexedDB with localStorage fallback.

### Settings

- `SwirPlatform.settings.get(key)`
- `SwirPlatform.settings.set(key, value)`
- `SwirPlatform.settings.remove(key)`
- `SwirPlatform.settings.userGet(userId, key)`
- `SwirPlatform.settings.userSet(userId, key, value)`

SWIR OS 1.5 uses this layer for hostname, language, network profiles and per-user appearance settings.

### Identity and sessions

- `SwirPlatform.identity.list()`
- `SwirPlatform.identity.get(id)`
- `SwirPlatform.identity.create(profile)`
- `SwirPlatform.identity.update(id, patch)`
- `SwirPlatform.identity.remove(id)`
- `SwirPlatform.identity.active()`
- `SwirPlatform.identity.setActive(id)`
- `SwirPlatform.identity.authenticate(id, pin)`
- `SwirPlatform.identity.lock()`
- `SwirPlatform.identity.session()`

Current Web adapter: local browser profiles stored in IndexedDB. Optional PIN is a convenience lock, not a secure OS credential boundary.

Future Desktop adapter: native desktop account/session backend.

Future System adapter: Linux users, PAM/session integration and privilege enforcement.

### Filesystem

- `SwirPlatform.files.list()`
- `SwirPlatform.files.get(id)`
- `SwirPlatform.files.save(file)`
- `SwirPlatform.files.remove(id)`

Current Web adapter: IndexedDB with migration support for earlier virtual filesystem data.

Future Desktop adapter: native filesystem sandbox.

Future System adapter: Linux filesystem / user home.

### Clipboard

- `SwirPlatform.clipboard.writeText(text)`
- `SwirPlatform.clipboard.readText()`
- `SwirPlatform.clipboard.clear()`

Current Web adapter: Clipboard API with internal fallback.

### Permissions

- `SwirPlatform.permissions.list()`
- `SwirPlatform.permissions.get(appId, permission)`
- `SwirPlatform.permissions.set(appId, permission, value)`

Native editions can enforce permissions at the adapter layer.

### Packages

- `SwirPlatform.packages.list()`
- `SwirPlatform.packages.install(pkg)`
- `SwirPlatform.packages.remove(id)`

Current Web adapter: local package/shortcut registry.

Future editions: signed SWIR package manifests and a real package manager.

### Processes

- `SwirPlatform.processes.list()`
- `SwirPlatform.processes.open(id)`
- `SwirPlatform.processes.kill(id)`

Current Web adapter: SWIR window-manager applications.

Future Desktop/System adapters: native processes and services where allowed.

### System

- `SwirPlatform.system.info()`
- `SwirPlatform.system.storageEstimate()`
- `SwirPlatform.system.clearRuntimeCaches()`

---

## Device & Network Core — 1.5

SWIR OS 1.5 introduces three user-facing system surfaces:

### Device Manager

Current Web Edition capabilities:

- hostname stored through `SwirPlatform.settings`
- platform / browser runtime information
- logical CPU count when exposed by the browser
- approximate device memory when exposed
- screen and viewport information
- storage usage / quota
- battery state when Battery API is available
- connection telemetry when Network Information API is available
- copyable device report through `SwirPlatform.clipboard`

Desktop/System editions can replace the Web adapter with real hardware enumeration.

### Network Center

Current Web Edition capabilities:

- online/offline state
- effective connection type when exposed
- approximate downlink and RTT when exposed
- portable SWIR network profiles
- active profile selection

**Web Edition cannot scan or connect to real Wi-Fi networks.** Browsers intentionally do not expose that level of device control. The profile model exists so a future Desktop/System adapter can connect the same UI to native networking.

Planned native mapping:

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

### System Settings

1.5 consolidates:

- device name
- language preference
- color core
- wallpaper
- reduced motion
- system sounds
- user/session shortcuts
- cache/storage controls
- links to Device, Network, Services and Update Center

Per-user settings use `SwirPlatform.settings.userGet/userSet`.

---

## System services

`SWIR Services` is the service-status surface shared by editions.

Current Web services/adapters include:

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

In Desktop/System editions these cards can map to native background services, daemons and hardware/network components.

---

## Network services

SWIR Chat is intentionally separated into two pieces:

```text
SWIR Chat client
      |
      v
SWIR Chat API
      |
      v
MySQL / MariaDB
```

The Web client lives in SWIR OS. The API is downloaded from **Chat Server Kit** and installed on a separate PHP hosting account. This keeps GitHub Pages static while allowing live multi-user communication.

Future transport can move from polling to WebSockets without changing the Chat application model.

---

## First Boot

Web Edition 1.4 introduced an OOBE / First Boot flow that configures:

- device name
- first local profile
- optional local PIN
- color core

1.5 reuses the same device identity in Device Manager and System Settings.

---

## Version roadmap

### Web Edition 1.x

Already implemented or actively being stabilized:

- desktop shell
- window manager
- launcher / taskbar
- First Boot / OOBE
- Identity & Session Core
- Device Manager
- Network Center
- System Settings
- File Explorer
- virtual filesystem
- Notes
- Calculator
- Music Player
- Matrix visual module
- SWIR Chat + downloadable server backend
- Task Manager
- SWIR Services
- permissions model
- package model
- clipboard
- Update Center

Next major Web Edition work:

- **1.6 Application SDK**
- application manifests
- centralized app permissions
- SWIR package format
- install/uninstall lifecycle
- file associations
- app data directories
- widgets
- notification API for applications

### Desktop Edition 2.x

Planned direction:

- native runtime such as Tauri or another lightweight shell
- native filesystem adapter
- real hardware/device adapter
- native network adapter
- native account/session adapter
- real process manager
- native clipboard
- tray integration
- global shortcuts
- file associations
- installers / updater
- sandboxed application permissions
- native service manager

### System Edition 3.x

Planned direction:

- Linux kernel
- bootable ISO
- SWIR boot splash
- SWIR login/session manager
- SWIR desktop shell
- NetworkManager integration
- hardware settings
- system services
- package manager
- updater
- filesystem integration
- recovery mode

The System Edition should use a proven Linux base rather than writing a kernel from scratch.

---

## Rule for future development

**UI should not know which edition it runs on.**

Whenever an application needs system functionality, prefer:

```js
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

over direct edition-specific APIs.

Device/network features that cannot be exposed through current Platform API should live behind a replaceable adapter layer until Platform API 3 formalizes those contracts.

This keeps SWIR OS portable.
