# SWIR Windows Compatibility Live E2E 0.1

## Purpose

This gate proves that the System Edition Windows compatibility stack can execute a real Windows user-mode PE program through a trusted distro Wine runtime. It exercises the production `WindowsCompatibilityRuntimeRegistry`, `ManagedWindowsCompatibilityStack` and `WindowsCompatibilityService` rather than a mocked process launcher.

The test is deliberately limited to Windows **user applications**. It does not install or load Windows kernel drivers, does not download arbitrary Wine/Proton binaries, and does not weaken Linux hardware-driver policy.

## Verified path

```text
signed/trusted SWIR package decision
        |
        v
swir.package-provider/0.2
executionClass = windows-compat
provider = swir.compat.wine
        |
        v
WindowsCompatibilityRuntimeRegistry
  approved runtime roots only
  realpath containment
  root ownership
  executable bit
  no group/world write
  real `wine --version` probe
        |
        v
ManagedWindowsCompatibilityStack
  per-app prefix
  signatureRequired = true
  trustVerified = true
  no arbitrary runtime download
        |
        v
WindowsCompatibilityService
  shell = false
  managed prefix containment
  .exe/.com only
        |
        v
real distro Wine process
        |
        v
controlled PE32+ fixture -> exit code 0
        |
        v
swir.windows-compat-live-e2e/0.1 evidence
```

## Fixture policy

CI builds a tiny deterministic user-mode Windows executable from source with the distro MinGW-w64 compiler. The fixture contains only `int main(void) { return 0; }`, is checked for an `MZ` header, copied into a managed per-app prefix, and executed through the production compatibility stack.

The fixture is not downloaded from a third-party site and is not a driver, installer or privileged component.

## Safety invariants

- Runtime discovery is limited to the approved local runtime roots already defined by the production registry.
- The selected Wine executable must resolve to a root-owned regular executable that is not group/world writable.
- Compatibility runtime downloads remain disabled.
- Every application receives a separate managed prefix.
- The entry point must remain inside that prefix and use a Windows user-application extension accepted by the guarded service.
- Package trust is explicitly required before `prepare`, `plan` and `launch`.
- The launch plan keeps `brokerRequired=true` and `shell=false`.
- The E2E process must return exit code 0; timeout or non-zero exit is a hard failure.
- Windows kernel drivers remain unsupported as a Linux hardware path.

## Roadmap interpretation

A green live-Wine gate proves real Windows user-application execution through the managed compatibility stack on a Linux host. The bootable System Edition lane should additionally execute the same gate inside the Debian 13 image before the roadmap item **managed Wine/Proton compatibility service for Windows user applications** is considered complete.

Proton remains an additional compatible provider path for applications that need it; the System Edition baseline does not require downloading Proton from an untrusted source just to satisfy this test.
