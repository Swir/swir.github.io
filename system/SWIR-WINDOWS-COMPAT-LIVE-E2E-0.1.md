# SWIR Managed Wine Live E2E 0.1

## Purpose

This gate proves that the existing System Edition managed Windows compatibility stack can launch an actual 64-bit Windows user application through a distro-provided Wine runtime on Linux. It goes beyond runtime discovery: CI compiles a tiny deterministic PE executable with MinGW, places it inside a SWIR-managed per-app prefix, launches it through the production `ManagedWindowsCompatibilityStack`, waits for the real Wine process to exit and verifies a marker written by the Windows program itself.

## Verified path

```text
Ubuntu distro Wine package
        |
        v
WindowsCompatibilityRuntimeRegistry
  realpath + executable + root ownership + mode + version probe
        |
        v
ManagedWindowsCompatibilityStack
        |
        +--> per-app managed prefix
        +--> .swir-compat.json metadata binding
        +--> signature/trust gate
        +--> approved runtime root
        |
        v
WindowsCompatibilityService
  shell=false
  sanitized environment
  .exe/.com user-app only
        |
        v
real Wine process -> real x86_64 Windows fixture -> marker + exit 0
```

## Safety invariants

- Wine is installed from the Ubuntu distribution repositories used by the CI runner; the test does not download a runtime from an arbitrary URL.
- The production runtime registry must discover a healthy, root-owned, non-group/world-writable Wine executable under an approved runtime root.
- The Windows payload must live inside its managed per-app prefix and carry matching SWIR prefix metadata.
- Launch requires `trustVerified=true` and a manifest with `signatureRequired=true`.
- The launcher keeps `shell=false`, uses the existing bounded environment allowlist and accepts user-mode `.exe/.com` payloads only.
- Windows kernel `.sys` drivers remain unsupported as a Linux driver path.
- The test creates no persistent host installation state beyond runner package installation and the temporary CI work directory.

## Evidence

A passing `swir.windows-compat-live-e2e/0.1` report records the trusted Wine executable/version, runtime ownership and write-safety, per-app prefix containment, metadata/trust binding, real process lifecycle, exit code and the marker produced by the Windows program.

The compiled fixture is not committed as a binary. CI builds it from a tiny C source with the distribution MinGW compiler, so the repository remains source-only and reproducible.

## Roadmap interpretation

The project already had a guarded Windows compatibility launcher, trusted Wine/Proton runtime registry, managed per-app prefixes and a package-driven runtime provisioner. When this real execution gate passes on the exact revision, it provides the missing live evidence for the scoped roadmap deliverable **managed Wine/Proton compatibility service for Windows user applications**: the managed Wine path executes a genuine Windows user application end-to-end instead of only discovering or mocking the runtime.

This does not claim that every Windows application works, that Proton is qualified on the same lane, or that Windows kernel drivers are supported. Broader application compatibility, graphics/game workloads and Proton-specific qualification remain follow-up coverage.
