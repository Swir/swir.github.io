# SWIR Debian 13 UEFI Bootable Image E2E 0.1

## Purpose

This gate advances the System Edition foundation from direct-kernel QEMU validation to a real disk-image boot path. It composes the selected Debian 13 (trixie) foundation into a GPT disk with an EFI System Partition and ext4 root filesystem, installs the Debian-provided `systemd-boot` EFI binary into the standard x86_64 fallback path, and boots the resulting image under QEMU/OVMF without QEMU `-kernel` or `-initrd` shortcuts.

The test remains disposable and CI-oriented. It proves a controlled amd64 UEFI boot path for the current System Edition foundation; it does not claim Secure Boot, physical-hardware qualification, an end-user installer, or recovery mode.

## Verified path

```text
Debian 13 official repositories
        |
        v
mmdebstrap foundation
        |
        +--> production SWIR rootfs provisioning
        +--> peer-authorization provisioning
        +--> Debian systemd-boot-efi
        +--> kernel + initramfs
        +--> distro Wine runtime
        |
        v
GPT raw disk
  p1: FAT32 SWIR_ESP
  p2: ext4  SWIR_ROOT
        |
        v
OVMF -> EFI/BOOT/BOOTX64.EFI -> systemd-boot
        |
        v
Debian kernel/initramfs -> systemd userspace
        |
        +--> systemd-logind
        +--> NetworkManager
        +--> SWIR peer-authorization socket
        +--> System Image Readiness probe
        +--> managed Wine runtime registry
        +--> unprivileged managed Wine user-app execution
        +--> NativePackageExecutionService (/usr/bin/true)
```

## Trust and safety boundaries

- The base rootfs continues to use the selected Debian profile, official Debian repositories, the Debian archive keyring and native APT signature verification.
- The UEFI bootloader comes from the distro package `systemd-boot-efi`. Before copying it to the ESP, the harness requires a regular non-symlink file, root ownership and no group/world write bit, then records SHA-256 evidence.
- The guest has no emulated network interface in this lane. NetworkManager is verified as an active native service without granting the guest external network access.
- The native Linux application execution check uses the existing `NativePackageExecutionService`, a System-targeted `linux-native` manifest, the `swir.package.system` provider, explicit trust verification and `/usr/bin/true`. The existing launcher keeps `shell=false` and an allowlisted executable root.
- The Wine runtime check uses the existing managed Windows compatibility runtime registry and requires a healthy, root-owned, non-group/world-writable distro Wine runtime.
- The Windows execution check builds a tiny deterministic PE32+ user-mode fixture from source with the distro MinGW-w64 compiler before image composition. The SHA-256 is recorded and the fixture is copied into the image; no third-party Windows binary is downloaded.
- Inside the booted guest, the fixture is executed as the unprivileged `swir-e2e` account through `ManagedWindowsCompatibilityStack` and `WindowsCompatibilityService`, using a per-app prefix below that user's home. Package trust remains required, the launch remains `shell=false`, and the test fails unless the real Wine child exits with code 0.
- Windows kernel drivers remain outside this compatibility path and are not treated as Linux hardware drivers.
- OVMF is test firmware supplied by the CI host package. Its SHA-256 is recorded as test evidence; this does not constitute a Secure Boot or production firmware claim.
- The large raw disk is deleted before artifact upload. CI retains compact serial output, readiness evidence, runtime inventories, Windows/native execution evidence and hashes.

## Evidence contract

Successful execution emits `swir.system-bootable-image-e2e/0.1`. The evidence must prove:

- Debian 13 trixie amd64;
- GPT + FAT32 EFI System Partition + ext4 root filesystem;
- UEFI boot through `systemd-boot` without direct-kernel injection;
- active systemd, logind, NetworkManager and SWIR peer-authorization socket;
- passed System Image Readiness checks;
- managed Wine runtime discovery;
- real Windows user-application execution as an unprivileged account through a per-app managed Wine prefix with verified package trust, `shell=false` and exit code 0;
- supervised native Linux application execution with exit code 0;
- SHA-256 values for the Windows fixture, bootloader, resulting image and OVMF code firmware.

The evidence must also keep `secureBootClaim`, `hardwareQualificationClaim`, `installerClaim` and `recoveryModeClaim` false.

## Roadmap interpretation

This E2E is sufficient evidence for the roadmap items **maintained Linux base/kernel and bootable image** and **native Linux application execution** after the dedicated CI gate passes on the exact revision being merged. Once the real Windows user-application execution path also passes both its standalone live gate and this booted Debian 13 gate, it provides implementation evidence for the scoped roadmap item **managed Wine/Proton compatibility service for Windows user applications**. Wine is the required baseline provider; Proton remains supported by the contract for applications that need it and must come from controlled sources rather than arbitrary downloads.

It does not complete the System Edition as a whole. Major remaining work includes a graphical SWIR boot/login/session path, the SWIR desktop shell, production Package Provider E2E inside the booted image, broader hardware qualification, Secure Boot policy, installer/media generation and recovery mode.
