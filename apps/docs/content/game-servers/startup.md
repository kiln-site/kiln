---
title: Startup
description: Change a game server's limits, version, Java version, and Brick settings, swap it to another Brick, or reinstall its Brick.
---

The **Startup** tab holds everything the Relay uses to build the game server's
container: its resource limits, its Brick, and the Brick's settings. Your
changes take effect when you apply them.

## Change settings

1. Open the game server's **Startup** tab.
2. Change what you need under **Resource Limits** and **Brick Configuration**.
3. Select the apply button. Its label says what happens next:
   - **Apply & Restart** when the server is running.
   - **Apply & Start** when it's stopped.
   - **Apply** when you can change settings but not start the server.

Applying rebuilds the container with the new settings. The server's files stay
as they are. After **Apply & Start**, Hearth opens the **Console** so you can
watch it start.

To change Startup, you need permission to change the game server's
configuration, and its Relay must be connected. If the server is running, you
also need permission to restart it.

## Resource limits

**Memory**, **CPU**, and **Disk** set the container's limits. Turn on
**No limit** to leave one unlimited. Each shows how much the Relay's machine can
still assign. See [Limits](/game-servers/create#limits).

For Minecraft Bricks, **Memory** is the whole container's limit, and Java's
heap uses up to 75% of it. The rest is left for Java itself, so a server with
4 GiB has a heap of about 3 GiB.

## Brick settings

**Brick Configuration** shows the game server's Brick and the settings that
Brick lets you change. Each Brick has its own. For the official Minecraft
Bricks they are:

| Setting               | What it does                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| **Minecraft version** | The game version to run. Pick one from the list or type it. Velocity calls it **Velocity version**. |
| **Java**              | The Java version it runs on. Picking a Minecraft version picks the Java version it needs.        |
| **Server Jar File**   | The file name Kiln downloads the server to and starts.                                           |
| **Java arguments**    | Extra JVM flags, such as garbage collector settings. Paper, Folia, and Fabric start with Aikar's flags. |

Palworld has a **Release channel** and **Server arguments**, the arguments
passed to `PalServer`.

Kiln runs Java 11, 17, 21, and 25. A Minecraft version that needs another Java
version, such as Java 8 or 16, can't be applied, and Hearth says which one it
needs.

### Java arguments

Kiln sets the heap size and the start command itself, shown read-only under
**Managed flags**. **Java arguments** can't set them: flags such as `-Xmx`,
`-Xms`, `-XX:MaxRAMPercentage`, `-jar`, and `--nogui`, and Java argument files
like `@flags.txt`, aren't accepted. To give the server more memory, raise its
**Memory** limit.

## Swap the Brick

To run the game server from a different Brick, such as moving a Paper server to
Fabric:

1. Under **Brick Configuration**, select **Swap Brick**.
2. Pick a Brick from the catalog, or a custom recipe, and select **Use Brick**.
3. Check the new Brick's settings, which start at its defaults.
4. Select the apply button.

The server keeps its files. A different server software may not read another's
worlds, plugins, or mods, so back up first. See [Backups](/backups).

## Reinstall the Brick

**Reinstall** rebuilds the container from the latest build of its
[Ember](/game-servers/bricks#embers) image, with the settings you last applied.
World data and files stay. Use it to pick up a fixed or updated Ember.

Unsaved changes on the Startup tab aren't applied by **Reinstall**. Apply them
first.
