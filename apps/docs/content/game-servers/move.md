---
title: Move or duplicate a game server
description: Copy a game server to another Relay, or to the same one, and choose whether the original keeps its place.
---

Kiln can copy a game server, files and all, to a new game server on any Relay
you can create game servers on. You choose what happens to the original:

- **Duplicate** keeps the original as it was. Use it to test an update on a
  copy, or to start a second server from the same world. The copy can go on any
  Relay, including the same one.
- **Move** hands the original's place to the copy on another Relay. The
  original is stopped and stays stopped, and you can delete it once the move
  finishes.

Either way, the copy is a new game server with its own ID.

## Copy a game server

1. Open the game server's **Info** tab.
2. Under **Move or duplicate**, select **Duplicate** or
   **Move to another Relay**. You can switch between the two at the top of the
   dialog.
3. Give the copy a name, and choose the **Relay** it goes to. A Relay that's
   too small for it shows **Won't fit**.
4. Check its **Limits**. They start as the original's. If you change them,
   **Reset** puts them back.
5. Choose whether to **Copy metadata**. See [What comes along](#what-comes-along).
6. For a duplicate, choose whether to **Stop while copying**.
7. Select **Duplicate** or **Move**.

A progress notice shows how the copy is going, and you can cancel it there.
When it finishes, you get a notification, even if you closed the notice or the
tab.

The original's Relay must be connected to open the dialog.

## What comes along

Every copy brings the game server's whole data folder, its Brick and Startup
settings, and its limits. Ports are new: the copy gets its own on its Relay,
so players connect to a new address.

**Copy metadata** brings the rest along where it can. Its info card in the
dialog lists what this game server has to bring and why any part can't come.

| Part                 | Duplicate | Move     | Notes                                                                                     |
| -------------------- | --------- | -------- | ----------------------------------------------------------------------------------------- |
| **User access**      | Yes       | Yes      | The same people and permissions. Pending invitations stay with the original.             |
| **Backups**          | Yes       | Yes      | The original's full backups, shared with the copy. Backups kept on the Relay's own disk come along only to a copy on the same Relay; backups in S3 come along anywhere. Incremental backups don't come along. |
| **Activity history** | Yes       | Yes      | The original's history, up to the copy.                                                   |
| **Domains**          | No        | Yes      | With Cloudflare connected, managed domains move and point at the new Relay. See [Cloudflare](/networking/cloudflare). |
| **Web routes**       | No        | Yes      | Routes move to the copy. Point their hostnames at the new Relay before HTTPS works again. |

## Stopping the original

A move always stops the original first, so its world is copied as it was when
it stopped, and leaves it stopped.

A duplicate can copy a running server. To copy a world that isn't being
written to, turn on **Stop while copying**: Kiln stops the original, copies it,
and starts it again.

> [!WARNING]
> A duplicate of a running Minecraft server can catch the world mid-save. Turn
> on **Stop while copying**, or run `save-all` in the console first.

## Room on the new Relay

The copy has to fit before anything changes. Hearth checks that the new Relay
can take the copy's memory, CPU, and disk limits, and that both Relays have the
disk space to pack and unpack the server's files, counted at their full size.

## After a move

When a move finishes, its notification offers **Delete old server**. Deleting
it works as it does anywhere else: you confirm with the server's ID and can take
a final backup first. Until you delete it, the original stays stopped on its
old Relay.

## If a copy fails

If a copy fails or you cancel it before it starts handing things over, Kiln
deletes the unfinished copy and starts the original again if the copy stopped
it. If it fails while handing things over, the new game server stays, since it
may already hold what moved. Either way, files packed for the copy are deleted
from both Relays.

## When Relays can't reach each other

The new Relay fetches the files straight from the original's Relay. If it
can't reach that Relay, such as when the original sits behind a home router,
the files pass through Hearth instead. You don't need to set anything up for
this. See [Transfers](/relays/transfers).
