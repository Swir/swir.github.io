# SWIR Windows Compatibility Live E2E 0.1

## Purpose

This gate exercises the managed Windows compatibility stack with a real Windows PE user application and a distro-provided Wine runtime. It moves the System Edition Windows path beyond mocked process launch while preserving the rule that Windows applications run through an explicit compatibility layer rather than being presented as native Linux processes.

## Verified path

```text
minimal x86_64 Windows PE fixture
        |
        v
signed/trusted package manifest contract
        |
        v
ManagedWindowsCompatibilityStack
        +--> root-owned runtime discovery
        +--> Wine version probe
        +--> per-app prefix metadata
        +--> entry-point confinement
        +--> environment allowlist
        +--> shell=false
        |
        v
real Wine process
        |
        v
Windows PE exits with code 0
```

The fixture is compiled during CI with the distro MinGW toolchain. No prebuilt executable is stored in the repository and no arbitrary runtime is downloaded.

## Security properties

- Wine is discovered only under approved runtime roots.
- The resolved Wine executable must be a regular executable, root-owned and not group/world writable.
- Runtime discovery uses a bounded scan and `wine --version` with `shell=false`.
- The Windows entry point must live inside the app's managed prefix and must end in `.exe` or `.com`.
- Package trust must already be verified and the manifest must require signatures.
- Each application receives a separate prefix with `.swir-compat.json` identity metadata.
- The process environment is allowlisted; arbitrary host environment variables are not forwarded.
- Arbitrary Wine/Proton downloads remain disabled.
- Windows kernel drivers remain unsupported as a general Linux driver path.

## Evidence

A successful run emits `swir.windows-compat-live-e2e/0.1` with the trusted Wine runtime/version, PE validation, managed-prefix properties, process PID/exit result and compatibility-policy flags.

## Roadmap interpretation

This is real live evidence for the Wine side of the **managed Wine/Proton compatibility service**. The service contract already supports both Wine and Proton providers, but this gate deliberately records `protonLiveE2E=false`; therefore the roadmap item remains open until Proton or an explicitly selected production compatibility profile receives equivalent live/System-image validation and the package-provision/update/recovery path is proven end to end.
