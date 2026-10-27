---
title: How Kiln fits together
description: Hearth, Relays, instances, Bricks and Embers, and how your browser reaches consoles and files.
---

Kiln splits the panel from the machines that do the work. Hearth decides what
should run; a Relay on each machine runs it.

## Hearth

Hearth is the web panel. It keeps accounts, permissions, schedules, and the
record of every game server, app, and database in its MySQL database. It
doesn't run your containers and has no access to Docker itself. It sends each
change to the Relay on the machine that runs it.

## Relays

A Relay is a container on each machine you own. It talks to Docker on that
machine and runs everything there: game servers, apps, and databases. It also
gives Hearth a terminal and a file browser for the machine itself.

Each Relay keeps a connection to Hearth. Either side can open it: Hearth
connects to the Relay, or the Relay connects to Hearth, so a machine behind a
router or firewall can still join. See [Relay connections](/relays/connections).

The Relay on the machine you installed Kiln on runs in **platform mode**. Besides
its own work, it installs Hearth, Hearth's database, and a cache, and keeps
them running and updated. Every other machine runs a plain Relay that you add
from Hearth. See [Self-hosting](/self-hosting).

## Instances

Everything Kiln runs for you is an **instance**:

- **Game servers**, each started from a Brick.
- **Apps**, deployed from a GitHub repository, a Docker image, a Dockerfile, or
  a Compose file.
- **Databases**: MySQL, MariaDB, PostgreSQL, Redis, or Valkey.

Each instance belongs to one Relay and runs in its own containers on that
machine. Access is granted per instance, so you can let someone manage one game
server without showing them the rest. See [Access](/access).

## Bricks and Embers

A **Brick** is a game server's recipe. It's data, not code: it names the
container image to run, the settings people can change (such as the Minecraft
version or memory), and the ports the game needs. A Relay can run a new Brick
without being updated.

Kiln's official catalog of Bricks lives in
[Kiln's repository](https://github.com/kiln-site/kiln/tree/main/apps/bricks).
When you add a game server you can also browse community catalogs, and write
Bricks of your own. See [Bricks](/game-servers/bricks).

An **Ember** is a ready-made runtime image that Bricks build on, such as Java
for Minecraft or SteamCMD for Steam games. The official ones are:

```text
ghcr.io/kiln-site/bricks-java:11
ghcr.io/kiln-site/bricks-java:17
ghcr.io/kiln-site/bricks-java:21
ghcr.io/kiln-site/bricks-java:25
ghcr.io/kiln-site/bricks-steamcmd:latest
```

A Brick can use any other container image too.

## Consoles and files

A game server's console and file transfers don't pass through Hearth when they
don't have to. Hearth checks that you're allowed in, then your browser
connects straight to the Relay and streams from it.

When your browser can't reach the Relay, such as when the Relay is behind a
firewall or runs beside Hearth in platform mode, the same streams go through
Hearth instead. They work the same way, but that traffic counts against
Hearth's bandwidth.

## Changes run in order

A Relay runs the changes to each instance one at a time, in the order they
arrive, whether they come from Hearth, a schedule, SFTP, or the console. A
restore waits for a running backup, and nothing starts a game server in the
middle of a restore. Changes to different instances run at the same time.

If a change is still waiting when Hearth disconnects from the Relay, cancels
it, or gives up waiting, it's withdrawn and never runs. A change that has
already started always finishes, since Docker work can't be undone halfway.
