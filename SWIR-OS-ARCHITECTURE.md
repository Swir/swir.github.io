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
 PWA cache          Native packages       SWIR packages
```

Applications should call `window.SwirPlatform` instead of reaching directly into browser-only APIs whenever possible.

---

## SWIR Platform API 2

Platform API 1 was introduced in **SWIR OS 1.3**. Platform API 2 arrives with **SWIR OS 1.4** and adds Identity, Sessions and Settings while preserving the existing API surface.

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

This is the portable system/user settings layer. First Boot currently stores device identity and per-user theme data here.

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

Current Web adapter: local browser profiles stored in IndexedDB. Optional PIN is only a convenience lock because client-side Web storage is not a secure OS credential boundary.

Future Desktop adapter: native desktop account/session backend.

Future System adapter: Linux users, PAM/session integration and real privilege enforcement.

### Filesystem

- `SwirPlatform.files.list()`
- `SwirPlatform.files.get(id)`
- `SwirPlatform.files.save(file)`
- `SwirPlatform.files.remove(id)`

Current Web adapter: IndexedDB with migration support for the legacy `swir-vfs-v12` data.

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

This is currently a prototype permission registry. Native editions can enforce permissions at the adapter layer.

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

## System services

`SWIR Services` is the service-status surface shared by editions.

Current Web services/adapters include:

- Window Manager
- Storage Service
- Identity Service
- Session Service
- Network Service
- Chat Service
- Cache Service
- Update Service
- Permission Service

In Desktop/System editions these cards can map to native background services, daemons and account/session components.

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

Web Edition 1.4 introduces an OOBE / First Boot flow that configures:

- device name
- first local profile
- optional local PIN
- color core

The same setup concept should later become the Desktop installer/OOBE and the System Edition first-boot wizard.

---

## Version roadmap

### Web Edition 1.x

Design and stabilize:

- desktop shell
- window manager
- launcher / taskbar
- First Boot / OOBE
- Identity & Session Core
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
- networking UI
- widgets
- application SDK

### Desktop Edition 2.x

Planned direction:

- native runtime such as Tauri or another lightweight shell
- native filesystem adapter
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
- system services
- package manager
- updater
- filesystem integration
- hardware/network settings
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

This keeps SWIR OS portable.
