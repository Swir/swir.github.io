# SWIR Graphical Session UEFI E2E 0.1

## Purpose

This lane moves System Edition beyond a console-only boot proof. It builds a disposable Debian 13 image from the existing controlled foundation, installs graphical components from Debian's signed repositories, boots the image through OVMF and `systemd-boot`, verifies that the SWIR Plymouth theme is actually active during boot, authenticates a disposable user through the real `greetd` + PAM path, and proves that the resulting local `systemd-logind` session can run a working Wayland compositor.

The lane does **not** claim that the final SWIR desktop shell is complete. Weston is the verified compositor/session foundation. The roadmap item `SWIR desktop shell` remains separate until the SWIR shell itself replaces the compositor test surface and is validated as the user's real desktop session.

## Production composition

The production graphical foundation uses distro-managed packages and fixed executables:

```text
Debian 13 signed repositories
        |
        +--> plymouth + plymouth-themes
        +--> greetd + distro PAM policy
        +--> weston + wayland-utils
        +--> dbus-user-session
        |
        v
SWIR graphical image provisioner
        |
        +--> SWIR Plymouth theme in initramfs
        +--> greetd display-manager service
        +--> authenticated agreety login
        +--> /usr/local/bin/swir-session
        +--> SWIR Wayland session descriptor
```

Production configuration deliberately uses `agreety` as the minimal authenticated greeter while the custom graphical SWIR login UI is still future work. There is no `initial_session` auto-login block. PAM remains the authentication authority; a successful greeter interaction is not treated as an identity proof outside the resulting logind session.

## Disposable CI authentication

Automated E2E cannot type into an interactive TTY reliably, so the disposable test image installs `greetd-e2e-greeter.py`. This small CI-only client speaks greetd's Unix-socket IPC protocol and answers the real PAM conversation for a dedicated unprivileged account named `swir-e2e`.

Important boundaries:

- the E2E credential exists only in the disposable VM composition;
- the production provisioning path never installs the E2E greeter and explicitly checks that the test credential is absent from production `greetd` configuration;
- no greetd `initial_session` auto-login is used;
- the final session must be attributed by `systemd-logind` to the authenticated UID and `Service=greetd`;
- the session must be local (`Remote=no`).

## Boot-splash proof

The image contains a custom script-based Plymouth theme at `/usr/share/plymouth/themes/swir`. Provisioning selects it through the distro `plymouth-set-default-theme` tool and regenerates every installed initramfs. Before boot, the host verifies that the theme descriptor is embedded in the actual initramfs copied to the EFI System Partition.

During the guest boot a dedicated early proof service requires:

- selected theme `swir`;
- kernel command line containing `quiet splash`;
- a responsive Plymouth daemon through `plymouth --ping` before the normal Plymouth quit phase.

This is stronger evidence than merely checking that theme files exist on disk.

## Wayland session proof

After PAM authentication, greetd starts `/usr/local/bin/swir-session`. In E2E mode the launcher starts Weston with the headless backend, waits for the Wayland socket and runs `wayland-info` against that socket. Evidence is accepted only when a client can observe the compositor global and the session can be tied back to the same authenticated UID in logind.

The headless backend is intentional for GitHub-hosted QEMU. The image still boots with a virtual VGA device, but this gate verifies session composition and Wayland protocol readiness rather than claiming physical GPU/DRM qualification.

## Fail-closed claims

A successful `swir.system-graphical-session-e2e/0.1` report proves only the scoped deliverable:

- UEFI/Systemd boot path reaches graphical target;
- SWIR Plymouth theme is active during boot;
- greetd and distro PAM perform a real authentication exchange;
- no auto-login path is used;
- systemd-logind observes a local greetd user session;
- Weston exposes a live Wayland socket that a client can use.

The report keeps all of these claims false:

```text
desktopShellClaim = false
secureBootClaim = false
hardwareQualificationClaim = false
```

It does not qualify Secure Boot, GPU acceleration, multi-seat, suspend/resume, physical display hardware, the final SWIR greeter UI, or the final SWIR desktop shell.

## Roadmap rule

Only after this E2E passes on the exact revision being merged may `SWIR boot splash and login/session manager` be marked complete. `SWIR desktop shell` must remain unchecked until the actual SWIR shell is launched as the verified graphical user session and its core desktop paths are exercised inside the booted System Edition image.
