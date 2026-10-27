---
title: Relays
description: A Relay runs on each machine with Docker, runs its game servers, apps, and databases, and keeps working when Hearth is away.
---

A Relay is Kiln's agent on a machine. Every machine that runs game servers,
apps, or databases runs one Relay, in a Docker container beside them. Hearth,
the web panel, tells each Relay what to do; the Relay does it with Docker on
its own machine.

## What a Relay does

- **Runs your instances.** It creates, starts, stops, and deletes the
  containers for its game servers, apps, and databases, and restarts a game
  server that crashes.
- **Keeps working without Hearth.** Crash recovery, backups already queued, and
  running game servers carry on while Hearth is down or unreachable. When Hearth
  connects again, it catches up on what happened.
- **Serves consoles and files.** Your browser streams consoles, uploads, and
  downloads straight from the Relay, so that traffic doesn't pass through Hearth.
  When your browser can't reach the Relay, as when it sits behind a home router,
  that traffic goes through Hearth instead. See
  [Connections](/relays/connections).
- **Runs your backups.** A Relay archives its instances' data and stores it on
  its own disk or uploads it to S3. See [Backups](/backups).
- **Gives you its host.** With host access on, Hearth can open a root terminal
  on the machine and browse its files. See [Host access](/relays/host).

Hearth itself also runs beside a Relay: the install command starts one Relay
that installs Hearth, its database, and its cache, and keeps them running.

## The Relays page

Open **Infrastructure → Relays** to see every Relay you can manage. Each row
shows the Relay's status, name, memory use, address (**Host / IP**), and owner.
Choose a Relay to open its pages:

| Page         | What it shows                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------- |
| **Info**     | Its name, Kiln ID, version, connection, TLS, and proxy settings, and what runs on the machine. |
| **Terminal** | A root shell on the machine. See [Host access](/relays/host#terminal).                         |
| **Volumes**  | The Relay's Docker volumes.                                                                    |
| **Files**    | The machine's own files. See [Host access](/relays/host#files).                                |
| **Logs**     | The Relay's own log.                                                                           |

You see only the pages your permissions allow.

## Pause, restart, and remove

The Relay's actions sit at the top of its pages and in each row of the Relays
page:

- **Pause** freezes the Relay. Its game servers keep running, but nothing on it
  changes until you choose **Resume**: no power actions, file changes, console
  input, schedules, backups, or new instances.
- **Restart Relay** restarts the Relay's own container. Game servers keep
  running, and the Relay reconnects in a few seconds.
- **Restart host** reboots the machine, and with it every game server, app, and
  database on it. It needs host access.
- **Remove Relay**, on the Info page under the danger zone, removes the Relay
  from Hearth.

## Next steps

- [Add a Relay](/relays/add) to put another machine in Kiln.
- [Choose which side connects](/relays/connections) when Hearth can't reach a
  machine.
- [See what the Relay needs](/relays/runtime) from Docker and the machine.
