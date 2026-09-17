# SWIR NetworkManager Integration 0.1

## Scope

This component is the first System Edition network adapter that talks to the base distribution's NetworkManager through the distro-owned `/usr/bin/nmcli` client. It is deliberately narrower than exposing `nmcli` directly to applications.

The service provides:

- NetworkManager general connectivity state;
- device inventory;
- saved connection-profile inventory identified by immutable UUID;
- Wi-Fi access-point discovery without exposing connection secrets;
- activation of an **existing** saved connection profile;
- deactivation of an active saved connection profile;
- post-mutation verification that the requested profile is actually active/inactive.

Creating, editing or deleting profiles is not part of 0.1. New Wi-Fi passwords are therefore not passed on the command line and applications cannot request `--show-secrets`.

## Binary and execution boundary

Production mode is pinned to `/usr/bin/nmcli`. Before use, the service requires a regular, non-symlink executable that resolves to the allowlisted path, is not group/world writable and is owned by the configured trusted UID (root by default).

Every invocation uses `execFile` semantics with:

```text
shell=false
PATH=/usr/sbin:/usr/bin:/sbin:/bin
LANG=C.UTF-8
LC_ALL=C.UTF-8
bounded timeout/output
```

No caller supplies raw `nmcli` arguments.

## Read-only inventory

0.1 uses explicit field lists with terse escaped output and parses NetworkManager escaping itself. Inventory intentionally omits secret-bearing commands.

Conceptually the adapter maps:

```text
nmcli general status
nmcli device status
nmcli connection show
nmcli device wifi list --rescan no
```

into `swir.networkmanager-inventory/0.1`.

Wi-Fi inventory may fail independently (for example on a machine with no Wi-Fi radio) without destroying wired/device/profile inventory.

## Authorized mutation

The only mutation templates are:

```text
nmcli --wait 45 connection up uuid <UUID> [ifname <IFACE>]
nmcli --wait 45 connection down uuid <UUID>
```

The profile UUID and optional interface name are strictly validated. Each mutation is represented as a deterministic plan whose SHA-256 digest is bound into a Polkit authorization request.

`PolkitNetworkAuthorizationBroker` binds authorization to:

- current Unix process PID;
- process start time from `/proc/<pid>/stat`;
- Unix UID / actor id;
- exact plan digest;
- exact connection UUID;
- exact operation (`activate` or `deactivate`);
- exact interface name when present.

The broker calls the distro `/usr/bin/pkcheck` with `shell=false`. User interaction is off by default and has to be explicitly requested by the trusted caller. The matching `system/security/org.swir.system.network.policy` defines only the two SWIR actions and defaults them to an active-user `auth_self_keep` check; inactive/other subjects are denied by default.

After an authorized command completes, SWIR queries active connection UUIDs and fails closed if the requested postcondition is not observed.

## Security choices

0.1 intentionally does **not** expose:

- `nmcli connection add/modify/delete`;
- `nmcli device wifi connect ... password ...`;
- `--show-secrets`;
- arbitrary interface/profile strings;
- arbitrary `nmcli` arguments;
- shell execution;
- an application-accessible NetworkManager D-Bus handle.

This keeps credentials and persistent network configuration behind future dedicated UI/secret-storage policy instead of smuggling them through an SDK call.

## Completion gate

The roadmap item **NetworkManager integration** remains incomplete after 0.1. The adapter is implemented and contract-tested, but the System Edition deliverable still needs a maintained target Linux image, a real NetworkManager daemon E2E covering Ethernet/Wi-Fi profile activation, suspend/reconnect behavior, secret-agent integration and failure recovery.
