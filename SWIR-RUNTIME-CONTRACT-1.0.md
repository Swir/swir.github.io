# SWIR Runtime Adapter Contract 1.0

## Goal

`swir.runtime/1.0` is the edition boundary for SWIR OS. Applications and system modules can target one stable runtime surface while Web, Desktop and System editions provide different implementations underneath.

```text
SWIR App / SWIR Service
        |
        v
   SwirRuntime
        |
        +--> Web Adapter
        +--> Desktop Native Host
        +--> System Native Host
```

## Runtime surfaces

```text
SwirRuntime.filesystem
SwirRuntime.processes
SwirRuntime.clipboard
SwirRuntime.tray
SwirRuntime.network
SwirRuntime.updater
```

The Web Edition delegates compatible operations to `SwirPlatform` and browser APIs. Unsupported privileged operations fail explicitly with `RUNTIME_UNSUPPORTED` instead of pretending to succeed.

## Native host injection

Desktop/System hosts can inject `window.SWIR_NATIVE_HOST` before `swir-runtime.js` loads. Each provided surface replaces the Web fallback for that surface only.

Example shape:

```js
window.SWIR_NATIVE_HOST = {
  edition: 'DESKTOP',
  filesystem: {
    list: async () => [],
    get: async id => null,
    save: async file => file,
    remove: async id => true,
    pickFile: async options => null,
    pickDirectory: async options => null
  },
  processes: {
    list: async () => [],
    spawn: async spec => ({ pid: 0 }),
    kill: async pid => true
  },
  clipboard: {
    readText: async () => '',
    writeText: async text => true,
    clear: async () => true
  },
  tray: {
    set: async options => ({ ok: true }),
    clear: async () => ({ ok: true })
  },
  network: {
    status: async () => ({ online: true }),
    adapters: async () => [],
    scan: async () => [],
    connect: async profile => ({ ok: true }),
    disconnect: async id => ({ ok: true })
  },
  updater: {
    check: async () => ({ updateAvailable: false }),
    apply: async plan => ({ ok: true }),
    restart: async () => true
  }
};
```

## Security rules

- Native hosts must validate every privileged request; JavaScript input is untrusted.
- Runtime adapters do not bypass SWIR package permissions or install-pipeline checks.
- `processes.spawn`, native network control, updater apply and real filesystem access are intentionally unavailable in the Web adapter.
- Desktop/System hosts should expose the minimum capability required and keep OS-specific implementation outside application code.
- Package verification and permission approval remain separate gates before native installation or execution.

## Diagnostics

`SwirRuntime.info()` reports the active edition, provider and available methods per surface.

`SwirRuntime.capabilities()` reports whether each surface is supplied by a native host or by the Web adapter.

The SWIR terminal command `runtime` prints the same capability map.

## Migration path

1. Web Edition validates application contracts using browser fallbacks.
2. Desktop Edition injects a lightweight native host and progressively implements real filesystem, process, tray, network and updater operations.
3. System Edition replaces the Desktop host implementation with Linux-native services while preserving `swir.runtime/1.0` where possible.

This contract is intentionally small. New privileged surfaces should only be added when a real Desktop/System use case cannot be represented safely by the existing interfaces.
