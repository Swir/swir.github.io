# SWIR OS — Architecture Roadmap

## Project direction

SWIR OS is being designed in three editions that share the same UX and application model:

1. **SWIR OS Web Edition** — current `swir.github.io` prototype and design laboratory.
2. **SWIR OS Desktop Edition** — future native desktop build with access to real files, processes, clipboard and networking.
3. **SWIR OS System Edition** — future bootable Linux-based operating system with the SWIR shell, services and applications.

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
 PWA cache          Native packages       SWIR packages
```

Applications should call `window.SwirPlatform` instead of reaching directly into browser-only APIs whenever possible.

---

## SWIR Platform API 1

Introduced in **SWIR OS 1.3**.

### Metadata

- `SwirPlatform.meta`
- Version / edition / build information.

### Storage

- `SwirPlatform.storage.get(key)`
- `SwirPlatform.storage.set(key, value)`
- `SwirPlatform.storage.remove(key)`

Current Web adapter: IndexedDB with localStorage fallback.

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

## Version roadmap

### Web Edition 1.x

Design and stabilize:

- desktop shell
- window manager
- launcher / taskbar
- File Explorer
- virtual filesystem
- Notes
- Calculator
- Music Player
- Task Manager
- permissions model
- package model
- clipboard
- Update Center
- networking UI
- users / sessions
- widgets
- application SDK

### Desktop Edition 2.x

Planned direction:

- native runtime such as Tauri or another lightweight shell
- native filesystem adapter
- real process manager
- native clipboard
- tray integration
- global shortcuts
- file associations
- installers / updater
- sandboxed application permissions

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
SwirPlatform.files
SwirPlatform.storage
SwirPlatform.clipboard
SwirPlatform.permissions
SwirPlatform.packages
SwirPlatform.processes
SwirPlatform.system
```

over direct edition-specific APIs.

This keeps SWIR OS portable.
