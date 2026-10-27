---
title: Host access
description: Open a root terminal on a Relay's machine, browse its files, and set up private registries and health checks.
---

A Relay can give Hearth a root terminal and the files of its machine. Host
access is on by default, and each part has its own permission.

> [!CAUTION]
> Host access is root on the machine. Grant `relay.terminal` and
> `relay.files.write` only to people you'd give SSH access.

## Terminal

The Relay's **Terminal** page opens a root shell on the machine. It needs
`relay.terminal`. Your session survives reloads; one nobody has open ends after
15 minutes (set `KILN_DATABASE_TERMINAL_IDLE_TIMEOUT_MINUTES` on Hearth, 1 to
1440). Restarting the Relay ends every session.

## Files

The Relay's **Files** page browses and edits the machine's files. It needs
`relay.files.read`, and `relay.files.write` to change them.

If it says **Host files aren't mounted**, choose **Mount host files**, then
**Mount and restart**. The Relay is offline a few seconds; game servers keep
running. This needs `relay.files.mount`. With Docker Compose, start the Relay
with the override instead:

```sh title="On the Relay's machine"
docker compose -f compose.yaml -f compose.host-files.yaml up -d
```

When the Relay can't open some files, the page says why. For SELinux, add
`security_opt: [label=disable]` to the Relay's service.

With host files mounted, the **Database** button on the **Info** page opens the
Relay's own SQLite database in Files.

> [!WARNING]
> The Relay's database holds sensitive configuration. Anyone with
> `relay.files.read` can read it.

## Turn host access off

Set `KILN_RELAY_HOST_ACCESS=false` in the Relay's environment and restart it.
The terminal, host files, and **Restart host** become unavailable.

## Private registries

The Relay doesn't see `docker login` on the host. To pull private images:

1. Write a Docker config file with credentials inline under `auths`. Credential
   helpers aren't supported.
2. Mount it into the Relay's container and set `DOCKER_CONFIG` to its directory.

One login covers images, Compose services, and Dockerfile `FROM` lines.

## Data, health, and memory

The Relay keeps its state, local backups, and game server files in the
`kiln-relay-data` volume.

Docker checks the Relay on `127.0.0.1` port 4101. Relays sharing a host network
each need their own `KILN_RELAY_HEALTH_PORT`; it must also differ from
`KILN_RELAY_PORT` and `KILN_RELAY_SFTP_PORT`. Outside monitors can use `/health`
on the Relay's main port.

The **Memory** column on the Relays page shows the Relay's own process; hover it
for the container's. Container memory counts file cache the kernel frees when
needed, so it overstates what the Relay holds.
