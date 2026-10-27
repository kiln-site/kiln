---
title: Create your first game server
description: Start a Minecraft Paper server, connect to it, and use its console and files.
---

This tutorial creates a Minecraft server from the Paper Brick, starts it, and
connects to it from Minecraft. It takes a few minutes, most of it downloading.

You need a Kiln with at least one Relay. The machine you
[installed Kiln](/get-started/install) on has one already.

## Create the server

1. In the sidebar, open **Game Servers**.
2. Choose **Add Game Server**.
3. Under **Categories**, choose **Minecraft**, then choose **Paper** in the
   list.
4. Under **Server details**, change the **Server name** if you like. It
   starts as "Paper Server".
5. Pick the **Relay** to run it on.
6. Choose **Provision**.

Kiln opens the server's **Startup** page while it works. "Provisioning in
background" shows its progress through **Prepare**, **Download**, **Build**,
and **Finalize**. You can leave the page; provisioning carries on, and the
page unlocks when it's done.

> [!NOTE]
> The Paper Brick accepts the
> [Minecraft EULA](https://www.minecraft.net/en-us/eula) for you when the
> server starts, so running it means you agree to it.

## Choose the version and memory

The **Startup** page holds the Brick's settings. Under **Brick
Configuration** you can set the **Minecraft version** and **Container
memory**, and under **Resource Limits** the server's **Memory**, **CPU**, and
**Disk**. Kiln picks working defaults, so you can skip this for now.

If you change something, choose **Apply**.

## Start it

Choose **Start** at the top of the page. The status changes to "Starting",
then "Running".

**Start**, **Stop**, **Restart**, and **Kill** are also in the power menu
beside it. **Kill** ends the server at once, so unsaved world data may be
lost.

## Connect from Minecraft

The server's address is in the page header, after its version. Select it to
copy it. The **Game Servers** list shows the same address in its **Host / IP**
column.

The address includes a port, such as `203.0.113.10:31234`. Kiln gives each game
server its own public port, from 30000 to 39999, rather than Minecraft's usual
25565, so paste the whole address.

In Minecraft, choose **Multiplayer**, then **Add Server**, and paste the
address.

> [!TIP]
> If Minecraft can't connect, check that nothing in front of the machine, such
> as your cloud provider's firewall or your router, blocks the port. See
> [Ports](/networking/ports).

## Use the console

Open **Console** to see the server's output live. Type a command in **Send a
server command…** and press <kbd>Enter</kbd>. For example, to make yourself an
operator:

```text
op YourName
```

<kbd>Tab</kbd> completes commands, and **Search console** finds lines in the
output. See [Console](/game-servers/console).

## Edit files

Open **Files** to browse the server's folder. Open `server.properties`, change
a setting such as `motd`, and choose **Save**. Restart the server for Minecraft
to read it.

To add plugins, open the `plugins` folder and drop `.jar` files onto the page,
or choose **Upload files** from the **+** menu. See
[Files](/game-servers/files).

## Next steps

- [Back up the server](/backups) before you change much.
- Give it a domain name with [Cloudflare](/networking/cloudflare).
- [Deploy your first app](/get-started/first-app).
