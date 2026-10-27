---
title: Host access
description: Open a root terminal on a Relay's machine, browse and edit its files, and read the Relay's own database from Hearth.
---

A Relay can give Hearth access to the machine it runs on: a root terminal and
the machine's files. Host access is on by default. Each part has its own
permission, so you decide who gets it.

> [!CAUTION]
> Host access is root on the machine. Anyone with `relay.terminal` or
> `relay.files.write` on a Relay can change anything on its host, including
> other Relays' and other programs' data. Grant these only to people you'd give
> SSH access.

## Terminal

The Relay's **Terminal** page opens a root shell on its machine, as SSH would.
It needs `relay.terminal`.

- Your session stays open when you reload the page, and when Hearth reconnects.
  Each person gets their own.
- A session nobody has open ends after 15 minutes. Set
  `KILN_DATABASE_TERMINAL_IDLE_TIMEOUT_MINUTES` on Hearth to change it, from 1
  to 1440 minutes.
- Restarting the Relay ends every session.

The shell runs in a small helper container, `kiln-host-shell`, that the Relay
creates the first time someone opens a terminal. It's privileged and shares the
host's processes, so it can enter the host's namespaces. Between sessions it
only sleeps.

**Restart host** in the Relay's actions also uses host access: it reboots the
machine with the host's own tools.

## Files

The Relay's **Files** page browses and edits the machine's files with the same
file browser and editor as game server and app files. It needs
`relay.files.read` to browse and download, and `relay.files.write` to change
files.

### Mount the host's files

The Relay can only see the machine's files when its filesystem is mounted into
the Relay at `/host`. Until it is, the Files page says **Host files aren't
mounted**.

To mount them from Hearth:

1. Open the Relay's **Files** page and choose **Mount host files**.
2. Choose **Mount and restart**.

The Relay restarts with the mount and is offline for a few seconds. Game servers
keep running. If it doesn't work, the Relay is put back as it was, and the page
shows why. Mounting needs `relay.files.mount`, which Relay owners and Kiln
Admins have by default.

If you run the Relay with Docker Compose, start it with the host files override
instead:

```sh title="On the Relay's machine"
docker compose -f compose.yaml -f compose.host-files.yaml up -d
```

Recreating the Relay from a Compose file without the override removes the
mount.

### Editing host files

Saving a host file overwrites it in place, as editors do, so its hard links and
containers that bind-mount it see the change.

Links with absolute targets point inside the Relay's container rather than the
host, so the Files page refuses to open them.

### Files the Relay can't reach

On some hosts the Relay can't open every file, and the Files page says why:

| The page says                                   | What to do                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Docker runs rootless on this host               | The Relay can only open files its Docker user can.                                   |
| Docker remaps container users on this host      | The Relay can only open files its remapped user can.                                 |
| The Relay isn't running as root                 | The Relay can only open files its user can.                                          |
| SELinux confines the Relay                      | Add `security_opt: [label=disable]` to the Relay's service to lift it.               |
| The host's filesystem is mounted read-only      | Files can be read but not changed.                                                   |

## The Relay's database

The Relay keeps its own state in a SQLite file, `/data/network/relay.sqlite`.
When host files are mounted and you have `relay.files.read`, the Relay's
**Info** page shows a **Database** button. It opens that file in Files, where you
can browse its tables and query them.

> [!WARNING]
> The Relay's database holds sensitive configuration. Anyone with
> `relay.files.read` on a Relay can read it.

## Turn host access off

Set `KILN_RELAY_HOST_ACCESS=false` in the Relay's environment and restart it.
The Terminal page then says **Host terminal unavailable**, the Files page says
**Host access is off**, and **Restart host** is unavailable. The Relay removes
its shell helper container.

Set it back to `true` to turn host access on again.
