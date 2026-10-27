---
title: Game servers
description: Each game server runs in its own container on a Relay, with a live console, files, startup settings, backups, and schedules.
---

A game server in Kiln is one container on one Relay, built from a
[Brick](/game-servers/bricks). The Brick says which image to run, which
settings you can change, and which ports the game needs. The Relay creates the
container, keeps it running, and restarts it if it crashes.

Open **Game Servers** in Hearth's sidebar to see every game server you can
reach, then select one to manage it.

## What each game server gets

- **Its own container.** Each game server has its own container and its own
  data folder on the Relay, with its own memory, CPU, and disk limits. Every
  container runs with a read-only root filesystem, dropped capabilities, a
  process limit, and its own network, whatever its Brick asks for.
- **A live console.** Read the server's output as it happens, search it, and
  send commands. See [Console](/game-servers/console).
- **Files.** Browse, edit, upload, and download the server's files in the
  browser, including Minecraft's NBT files and SQLite databases. See
  [Files](/game-servers/files).
- **Startup settings.** Change the version, Java version, memory, and the
  Brick's other settings, or swap to a different Brick. See
  [Startup](/game-servers/startup).
- **Power controls and crash recovery.** Start, stop, restart, or kill it.
  When it exits on its own, the Relay starts it again. See
  [Power and crash recovery](/game-servers/power).
- **Backups.** Back it up to the Relay's disk or to S3, by hand or on a
  schedule. See [Backups](/backups).
- **Schedules.** Restart it, back it up, or run a console command on a
  timetable. See [Schedules](/game-servers/schedules).
- **Access.** Invite people to one game server and choose what they can do.
  See [Access](/access).

## Official Bricks

Kiln's own catalog has these Bricks. Hearth marks them **Verified**.

| Brick    | Game      | What it runs                                                   | Relay architecture |
| -------- | --------- | -------------------------------------------------------------- | ------------------ |
| Paper    | Minecraft | Fast, plugin-compatible Minecraft server for most projects.    | amd64, arm64       |
| Folia    | Minecraft | Paper's regionized multithreaded server for busy worlds.       | amd64, arm64       |
| Fabric   | Minecraft | The Fabric mod loader.                                         | amd64, arm64       |
| Velocity | Minecraft | A Minecraft proxy that joins several servers into one network. | amd64, arm64       |
| Palworld | Palworld  | The Palworld dedicated server, installed through SteamCMD.     | amd64 only         |

You can also add other people's catalogs, or point Kiln at a Brick you wrote
yourself. See [Bricks](/game-servers/bricks).

## A game server's pages

Each game server has these tabs. You see only the ones your access allows.

| Tab         | What it's for                                                                              |
| ----------- | ------------------------------------------------------------------------------------------ |
| **Console** | The live console, and power controls. See [Console](/game-servers/console).                |
| **Files**   | The file manager and editor. See [Files](/game-servers/files).                             |
| **Startup** | Resource limits, the Brick, and its settings. See [Startup](/game-servers/startup).        |
| **Network** | Its ports and public address. See [Ports](/networking/ports).                              |
| **Info**    | Its name, icon, Brick, and connect address, moving it, and deleting it.                    |

## Delete a game server

1. Open the game server's **Info** tab.
2. Under **Danger zone**, select **Delete server**.
3. Copy the server ID shown in the dialog and paste it back to confirm. Hearth
   may also ask for your account password.
4. To keep a copy, check **Back up server before deleting** and choose where
   the backup goes.
5. Select **Delete server**.

> [!CAUTION]
> Deleting a game server removes its container and all of its files from the
> Relay. Without a final backup, they can't be recovered.

The game server's Relay must be connected to delete it.

## Next steps

- [Create a game server](/game-servers/create)
- [Bricks](/game-servers/bricks)
- [Move or duplicate a game server](/game-servers/move)
