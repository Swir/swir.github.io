# SWIR Hardware Service Live E2E 0.1

## Purpose

This gate verifies the existing System Edition Hardware Service against a real Linux kernel sysfs tree instead of only synthetic fixtures. It is intentionally read-only: the test inventories live PCI/USB devices, records the currently bound kernel driver where sysfs exposes one, applies the SWIR Hardware Catalog, runs the preview-only Driver Resolver and feeds the result through the diagnostics-only Driver Center policy boundary.

The goal is to prove that the portable Hardware Service contract works on a real Linux host without adding arbitrary driver downloads or privileged mutation behavior.

## Verified path

```text
Linux kernel sysfs
  /sys/bus/pci/devices
  /sys/bus/usb/devices
          |
          v
SWIR Hardware Service
  normalized PCI/USB IDs
  loaded/unbound driver state
  modalias
  distro/package/fwupd capabilities
          |
          v
SWIR Hardware Catalog
          |
          v
Driver Resolver (preview only)
          |
          v
Driver Center (diagnostics only)
          |
          v
swir.hardware-live-e2e/0.1 evidence
```

## Safety invariants

- The probe does not execute driver installers, package managers, firmware tools or shell commands.
- Device paths must originate from the expected `/sys/bus/<pci|usb>/devices/` namespace and resolve inside kernel `/sys/devices`.
- PCI/USB identifiers are validated as normalized four-digit hexadecimal IDs.
- At least one live PCI device and one bound kernel driver must be observed for this CI lane to count as live evidence.
- Driver/source recommendations remain restricted to `kernel-in-tree`, `linux-firmware`, `distribution-repository`, `fwupd-lvfs` and explicitly allowlisted `vendor-official-repository` classes.
- Direct arbitrary driver URLs are rejected by the live evidence gate.
- Unknown hardware remains diagnostic-only; no automatic download is permitted.
- Windows `.sys` drivers are not treated as a general Linux hardware path.
- Driver Resolver output must stay `readOnly=true` and `autoExecutable=false`.
- Driver Center output must stay `readOnly=true`, `autoMutation=false` and contain zero trust-policy violations.

## Evidence

A successful run emits `swir.hardware-live-e2e/0.1` with the Linux distribution/kernel, architecture, PCI/USB counts, number of bound drivers, catalog match count, detected package managers and Driver Center policy result.

The evidence deliberately keeps `hardwareQualificationClaim=false`. GitHub-hosted Linux runners are useful real-kernel integration evidence, but they are not a substitute for qualification across physical AMD/Intel/NVIDIA laptops/desktops, USB peripherals, suspend/resume, hotplug, IOMMU and firmware-update cases.

## Roadmap interpretation

After this gate passes on the exact revision being merged, it is sufficient implementation evidence for the scoped roadmap item **Hardware Service with PCI/USB inventory** because the service already has normalized PCI/USB discovery, catalog matching and read-only safety contracts and this gate proves the same production code against live kernel sysfs.

It does **not** by itself complete **SWIR Driver Center / Hardware Catalog**, **in-tree Linux drivers + linux-firmware as primary hardware path**, **fwupd/LVFS firmware updates**, vendor repositories, or broad hardware qualification. Those remain separate production gates.
