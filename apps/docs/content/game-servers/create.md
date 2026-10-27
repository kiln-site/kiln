---
title: Create a game server
description: Start a game server from a Brick, choose the Relay it runs on, then set its version, memory, and limits before its first start.
---

You need at least one connected Relay. If you don't have one yet, see
[Add a Relay](/relays/add).

## Create it

1. Open **Game Servers** in the sidebar and select **Add Game Server**.
2. Pick a Brick. Filter by **Minecraft**, **Steam**, or **Other**, or search
   by name. The panel on the right shows the selected Brick's details.
3. Under **Server details**, give it a **Server name**.
4. Choose the **Relay** it runs on.
5. Select **Provision**.

Kiln creates the game server stopped and opens its **Startup** tab. Review its
settings there, then select **Apply & Start**. See [Startup](/game-servers/startup).

If you don't see **Add Game Server**, you don't have permission to create game
servers on any Relay. Ask whoever runs your Kiln for access.

## Choose a Relay

The **Relay** list shows every Relay you can create game servers on. Some
entries may be greyed out:

- **incompatible**: the Relay's CPU architecture isn't one the Brick supports.
  Palworld, for example, runs only on amd64 machines.
- **Selected Relay is not connected**: Hearth can't reach that Relay right now.
  You can provision on it once it reconnects.

A game server stays on the Relay you choose. To run it somewhere else later,
see [Move or duplicate a game server](/game-servers/move).

## What Kiln sets up

When you select **Provision**, the Relay:

- Pulls the Brick's [Ember](/game-servers/bricks#embers) image, such as
  `ghcr.io/kiln-site/bricks-java:21` for a Minecraft server.
- Creates the game server's data folder and container, with the Brick's
  default settings.
- Reserves a public port for the game and records it on the **Network** tab.
- Sets a disk limit of 5 GiB, and a memory limit from the Brick's default, such
  as 2 GiB for Paper. Change either on the **Startup** tab.

For the Minecraft Bricks, Kiln also picks the Java version that the Minecraft
version needs, so you don't have to. A Velocity server gets the newest Velocity
build and its Java version when it's created.

The first start downloads the server itself, so it takes longer than later
starts.

> [!NOTE]
> On its first start, a Minecraft server's Ember writes `eula=true` to
> `eula.txt`. Running a Minecraft server means you accept the
> [Minecraft EULA](https://www.minecraft.net/en-us/eula).

## Limits

Each game server has three limits, set on the **Startup** tab under
**Resource Limits**:

| Limit      | What it does                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| **Memory** | The container's hard memory limit, in GiB. For Minecraft, Java's heap uses up to 75% of it.             |
| **CPU**    | How many CPU cores the container may use.                                                               |
| **Disk**   | How much disk the game server's files may take, in GiB.                                                 |

Turn on **No limit** to leave one unlimited. Each field shows how much the
Relay's machine can still assign, and Hearth won't save a limit larger than
that.

> [!WARNING]
> When a running game server's files grow past its disk limit, the Relay stops
> it, and it won't start again until its files fit. Raise the limit or delete
> files to start it.

## Ports

Kiln picks a free public port on the Relay for the game's main port, so you
don't choose one when you create a game server. Find the address players
connect to on the game server's **Network** tab, under **Public Address**, or
on its **Info** tab. To add more ports, such as one for a voice chat plugin, see
[Ports](/networking/ports).

## Use a Brick of your own

To run a game that isn't in a catalog, open **Custom Brick** in the Brick
picker, select **Add Brick**, paste the **Recipe URL**, and select
**Save Brick**. Kiln checks the recipe on the Relay and keeps it in your
custom Bricks. See [Bricks](/game-servers/bricks) for how to write one.
