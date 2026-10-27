---
title: Game servers
description: Create a game server from a Brick, connect to it, control its power, and change its limits and settings.
---

Each game server is one container on one Relay, built from a
[Brick](/game-servers/bricks).

## Create a game server

You need a connected Relay. See [Get started](/#add-a-relay).

1. Open **Game Servers** in the sidebar and select **Add Game Server**.
2. Pick a Brick, such as **Paper** under **Minecraft**.
3. Under **Server details**, give it a **Server name**.
4. Choose the **Relay** it runs on.
5. Select **Provision**.

Kiln opens the **Startup** tab while it provisions. When it's done, check the
[settings](#startup-settings) and select **Apply & Start**. The first start
downloads the game, so it's slower.

Kiln's own Bricks, marked **Verified**, are Paper, Folia, Fabric, and Velocity
for Minecraft, and Palworld, which needs an amd64 Relay. A Relay that doesn't
fit shows **incompatible**. For other Bricks, see
[Bricks](/game-servers/bricks).

The Relay reserves a public port and sets a 5 GiB disk limit and the Brick's
default memory, such as 2 GiB for Paper. For Minecraft, Kiln picks the Java
version the game version needs.

> [!NOTE]
> A Minecraft server's Ember writes `eula=true` to `eula.txt`. Running one
> means you accept the [Minecraft EULA](https://www.minecraft.net/en-us/eula).

## Connect to it

Select the address in the game server's page header to copy it. It includes
the port Kiln picked, such as `203.0.113.10:31234`, so paste the whole thing.
If players can't connect, see [Ports](/networking#ports).

## Power controls

The power button sits at the top right of every tab, with **Power Options**
beside it:

- **Stop** asks the server to shut down cleanly, and forces it after 60
  seconds.
- **Restart** stops it cleanly and starts it again.
- **Kill** ends it at once, after **Kill now**. The server can't save, so
  recent world changes can be lost.

A started server shows as starting until its ready line appears in the
console, such as Minecraft's `Done (…)!`, for up to two minutes.

## Crash recovery

When a server you left running exits on its own, from an error, running out of
memory, or stopping itself, the Relay starts it again. The console says why,
such as **Server ran out of memory. Automatic restart scheduled — attempt 1 of
2.** **Stop**, **Kill**, or its stop command typed in Hearth's console leave it
stopped. Recovery runs on the Relay, so it works while Hearth is down.

The Relay tries twice, waiting 5 seconds, then three times longer each try, up
to a minute. After 5 minutes up, the count resets. If every try fails, it
leaves the server stopped. Read the console from before the crash, raise
**Memory** or remove the failing plugin, then start it.

Each Relay's environment can change this for all its game servers:

| Variable                               | Default | Range      |
| -------------------------------------- | ------- | ---------- |
| `KILN_RELAY_CRASH_RETRY_LIMIT`         | `2`     | 0 (off) to 10 |
| `KILN_RELAY_CRASH_RETRY_DELAY_SECONDS` | `5`     | 0 to 300   |
| `KILN_RELAY_CRASH_STABILITY_SECONDS`   | `300`   | 15 to 3600 |

## Disk limit

When a running server's files grow past its **Disk** limit, the Relay stops it
and won't start it until they fit. Raise the limit or delete files.

## Startup settings

The **Startup** tab holds the limits, the Brick, and its settings. Change
them, then select **Apply & Restart**, **Apply & Start**, or **Apply**. That
rebuilds the container; files stay.

- **Memory**, **CPU**, and **Disk**. **No limit** leaves one unlimited. For
  Minecraft, Java's heap uses up to 75% of **Memory**.
- **Brick Configuration**: for Minecraft, **Minecraft version**, **Java**,
  **Server Jar File**, and **Java arguments**. Kiln runs Java 11, 17, 21, and
  25. **Java arguments** can't set heap or start flags such as `-Xmx` or
  `-jar`; raise **Memory** instead.
- **Swap Brick** changes the Brick, such as Paper to Fabric. Files stay, but
  the new software may not read them, so [back up](/backups) first.
- **Reinstall** rebuilds from the latest Ember with your last applied
  settings.

## Delete a game server

1. On the **Info** tab, under **Danger zone**, select **Delete server**.
2. Paste the server ID to confirm. Hearth may ask for your password.
3. To keep a copy, check **Back up server before deleting**.
4. Select **Delete server**.

> [!CAUTION]
> This removes the container and all its files from the Relay. Without a
> backup, they can't be recovered.
