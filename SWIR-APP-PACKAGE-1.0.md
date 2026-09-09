# SWIR App Package 1.0

## Purpose

SWIR App Package defines one application model shared by SWIR OS Web, Desktop and System editions.

```text
SWIR application
      |
      v
app manifest (swir.app/1.0)
      |
      +--> Web Edition: registered same-origin entry + browser adapter
      +--> Desktop Edition: packaged application + native adapter
      +--> System Edition: packaged application + Linux/SWIR adapter
```

The Web Edition does not pretend to install native binaries. Installation registers an official application manifest, compatibility requirements, dependencies, permissions, file associations and package state in the SWIR Platform package layer. Desktop/System editions can later use the same manifest inside a real `.swirapp` archive.

## Manifest

Example:

```json
{
  "schema": "swir.app/1.0",
  "id": "code",
  "packageId": "swir.code",
  "name": "SWIR Code",
  "version": "1.1.0",
  "author": "SWIR",
  "description": "Code and text editor",
  "category": "Developer",
  "icon": "</>",
  "accent": "#48a8ff",
  "type": "iframe",
  "entry": "./swir-code.html",
  "desktop": true,
  "permissions": ["files.read", "files.write", "clipboard", "downloads"],
  "associations": [".txt", ".html", ".css", ".js", ".json", ".md"],
  "appData": "SWIR://APPDATA/CODE",
  "compatibility": {
    "minOS": "1.7.0",
    "minSDK": "1.2.0",
    "platformApi": 2,
    "editions": ["WEB", "DESKTOP", "SYSTEM"]
  },
  "dependencies": [],
  "optionalDependencies": []
}
```

Required fields: `schema`, `id`, `packageId`, `name`, `version`, `author`, `type`, `entry`.

Package IDs must be unique. Official SWIR packages use the `swir.*` namespace.

## Compatibility & dependency model — SWIR OS 1.7 / App SDK 1.3

The package resolver implements `swir.dependencies/1.0`.

`compatibility` can declare:

- `minOS` — minimum SWIR OS version.
- `minSDK` — minimum SWIR App SDK version.
- `platformApi` — minimum SWIR Platform API revision.
- `editions` — allowed runtime editions such as `WEB`, `DESKTOP`, `SYSTEM`.

`dependencies` contains required packages. A dependency entry may reference an official package and a minimum version:

```json
{
  "packageId": "swir.example-runtime",
  "minVersion": "1.4.0"
}
```

`optionalDependencies` uses the same shape but produces a warning instead of blocking installation.

Before installation SWIR Store asks the resolver for an install plan:

```text
PACKAGE MANIFEST
      |
      v
SWIR Package Resolver
      |
      +--> OS version
      +--> App SDK version
      +--> Platform API
      +--> Edition
      +--> required packages + versions
      |
      v
COMPATIBLE ?
  YES -> permission review -> install
  NO  -> block install + diagnostics
```

Removal is also dependency-aware. If another installed package declares the target as a required dependency, Store refuses removal until dependent packages are removed or upgraded.

Portable resolver API:

```text
SwirAppSDK.packages.check(id)
SwirAppSDK.packages.planInstall(id)
SwirAppSDK.packages.planRemove(id)
SwirAppSDK.packages.audit()
SwirAppSDK.packages.runtime()
```

This contract is intentionally edition-neutral. Desktop/System installers can reuse the same planning phase before downloading, verifying and unpacking native payloads.

## File associations — SWIR OS 1.7

`associations` is an optional list of lowercase file extensions handled by the application.

Examples:

```text
swir.code          -> .txt .html .htm .css .js .json .md .log
swir.image-studio  -> .png .jpg .jpeg .webp .gif
swir.archive       -> .zip
swir.pdf-viewer    -> .pdf
```

Declaring an extension does not automatically make an application the default. The package must be installed, and the user can choose the default handler in **Default Apps** / **Open With**.

Web Edition stores defaults locally through the SWIR File Association service. Desktop/System editions can map the same manifest field to native MIME/file associations.

## App Data

`appData` identifies the application's private logical data namespace.

```text
SWIR://APPDATA/CODE
SWIR://APPDATA/IMAGE
SWIR://APPDATA/CHAT
```

In Web Edition this maps to namespaced SWIR Platform storage. Applications should access it through `SwirAppSDK.storage.namespace(appId)` / `SwirAppSDK.files.appData(appId)` rather than directly assuming a browser storage backend.

Desktop Edition can map this to an application-specific data directory. System Edition can map it to an application/user data location under the native filesystem.

## Web Edition installation

```text
Store catalog
    |
    v
Show compatibility + dependencies + permissions + file associations
    |
    v
Package Resolver approves install plan
    |
    v
User confirms INSTALL
    |
    +--> SwirPlatform.packages.install(manifest)
    +--> SwirPlatform.permissions.set(...)
    +--> register declared file handlers
    +--> local launcher registry mirror
    |
    v
Application becomes visible after shell refresh
```

All official Web Edition entries must be same-origin files shipped with SWIR OS. Arbitrary remote JavaScript is not treated as a trusted SWIR package.

## Opening a file

```text
SWIR File Explorer
       |
       v
read file extension
       |
       v
File Association Service
       |
       +--> configured default app
       +--> first installed compatible handler
       |
       v
Open app + hand off file payload
```

If no compatible package is installed, File Explorer can offer SWIR Store or use a built-in fallback where appropriate.

## Uninstall

Uninstall removes package registration and disables granted package permissions only after dependency protection confirms that no installed package requires the target. Its file associations stop being active immediately after the shell rebuild. Application source remains part of the Web build/cache because GitHub Pages is a static deployment. Desktop/System editions can physically remove package payloads.

Future uninstall flow:

```text
REMOVE APP
  |
  +--> CHECK DEPENDENTS
  +--> Remove program only
  +--> Remove program + user data
```

## Permission names

Initial SWIR App Package 1.0 permission vocabulary:

- `files.read`
- `files.write`
- `clipboard`
- `downloads`
- `network`
- `storage`
- `notifications`
- `identity.basic`

Later native-only permissions may include camera, microphone, devices, processes, terminal, services and privileged system operations. Native editions must enforce those at the adapter/service boundary.

## Core vs optional applications

Core system components are registered independently of Store and cannot be removed in Web Edition:

- App Center
- SWIR Store
- File Explorer
- Default Apps
- System Settings
- User Manager
- Device Manager
- Network Center
- Task Manager
- SWIR Services
- Update Center
- Platform Control
- Terminal

Optional 1.7 packages:

- `swir.code` — SWIR Code
- `swir.image-studio` — Image Studio
- `swir.archive` — Archive Manager
- `swir.pdf-viewer` — PDF Viewer
- `swir.chat` — SWIR Chat

## Future `.swirapp` archive

Desktop/System target structure:

```text
Example.swirapp
├── app.json
├── index.html / executable entry
├── app.js
├── app.css
├── icon.svg
├── assets/
└── signature.json
```

Target install pipeline:

```text
DOWNLOAD / SELECT .swirapp
  -> VERIFY MANIFEST
  -> RESOLVE OS / SDK / API / PACKAGE DEPENDENCIES
  -> VERIFY SIGNATURE
  -> DISPLAY PERMISSIONS
  -> REGISTER FILE TYPES
  -> CREATE APP DATA DIRECTORY
  -> INSTALL PAYLOAD
  -> REGISTER PACKAGE VERSION
  -> LAUNCH
```

## Security rule

A package manifest is metadata, not authority. Applications must not gain a capability merely because they list it in `permissions`. The platform adapter/service is responsible for checking granted permissions before sensitive operations. File associations likewise do not grant file access by themselves; an application still requires the relevant file permission and a file handoff selected by the user or operating system. Compatibility and dependency fields are validated by the resolver, but native editions must additionally verify package signatures and payload integrity before installation.
