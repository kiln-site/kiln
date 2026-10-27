---
title: Move or duplicate
description: Copy a game server, files and all, to another Relay or the same one, and choose whether the original keeps running.
---

Kiln copies a game server to a new game server with its own ID:

- **Duplicate** leaves the original as it was. The copy can go on any Relay,
  including the same one.
- **Move** stops the original and leaves it stopped, so you can delete it once
  the copy is ready.

## Copy a game server

1. On the game server's **Info** tab, under **Move or duplicate**, select
   **Duplicate** or **Move to another Relay**.
2. Name the copy and choose its **Relay**. One that's too small shows **Won't
   fit**.
3. Check its **Limits**, which start as the original's.
4. Choose whether to **Copy metadata**, and for a duplicate, whether to
   **Stop while copying**.
5. Select **Duplicate** or **Move**.

A notice shows progress and lets you cancel. You get a notification when it
finishes. When a move finishes, the notification offers **Delete old server**.
Both Relays must be connected.

> [!WARNING]
> A duplicate of a running Minecraft server can catch the world mid-save. Turn
> on **Stop while copying**, or run `save-all` first.

## What comes along

Every copy brings the data folder, the Brick and Startup settings, and the
limits. Ports are new, so players connect to a new address.

**Copy metadata** also brings:

| Part                 | Duplicate | Move | Notes                                                                                         |
| -------------------- | --------- | ---- | --------------------------------------------------------------------------------------------- |
| **User access**      | Yes       | Yes  | Pending invitations stay with the original.                                                   |
| **Backups**          | Yes       | Yes  | Full backups only. Backups on the Relay's disk come only to a copy on the same Relay; S3 backups come anywhere. |
| **Activity history** | Yes       | Yes  |                                                                                               |
| **Domains**          | No        | Yes  | With [Cloudflare](/networking#cloudflare) connected, they point at the new Relay.             |
| **Web routes**       | No        | Yes  | Point their hostnames at the new Relay before HTTPS works again.                              |

## Before it starts

Hearth checks that both Relays are connected, run a Kiln release that can copy
between Relays, and let Hearth download and upload files, and says which to
fix. The new Relay needs room for the copy's limits and disk for the archive
plus the unpacked files; the original's needs disk for the archive. Archives
count at full size, since worlds barely compress.

The new Relay fetches the files straight from the original's. If it can't
reach it, such as behind a home router, the copy passes through Hearth and
counts against [what Hearth carries](/relays/connections#relays-reached-through-hearth). A dropped
connection doesn't start the copy over; the new Relay resumes for about four
minutes.

## If a copy fails

If a copy fails or you cancel it early, Kiln deletes the unfinished copy and
restarts the original if it stopped it. If it fails while handing things
over, the new game server stays, since it may hold what moved. Packed files
are deleted from both Relays either way, or after a day if a Relay crashed.
