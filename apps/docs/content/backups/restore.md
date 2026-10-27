---
title: Restore and download backups
description: Put a game server or database back as a backup left it, download a backup, or share a temporary link to one.
---

Every backup in **Backups → Runs** can be restored in place, downloaded, or
deleted from its row.

## Restore a backup

Restoring replaces the game server's files, or the database's contents, with the
backup's.

1. For a game server, stop it first. Databases stay running while they restore.
2. Open **Backups → Runs** and find the backup. To narrow the list, choose the
   instance in the picker at the top, or filter by status.
3. Choose **Restore** in its row.
4. Leave **Safety backup** on to take a new full backup of the current state
   first. If the restore isn't what you wanted, you can restore that one.
5. Choose **Restore backup**.

The restore runs on the Relay, in the same queue as backups. With a safety
backup, the restore starts only once the safety backup has succeeded. If the
Relay is offline, Hearth saves the request and the restore starts once it
reconnects.

A game server's restore unpacks the backup beside the server's folder, checks it,
then swaps it in, so a failed restore doesn't leave the server half-replaced.

**Restore** is unavailable while the backup is still running, and when the game
server or database it came from no longer exists.

To restore Kiln itself, see [Kiln's own backups](/backups/platform#restore-kiln).

## Download a backup

1. Choose the download button in the backup's row.
2. Under **Source**, choose which copy to download: **Local Relay** or one of
   its S3 destinations.
3. Choose **Download**.

Incremental backups download as a zip. The Relay builds it first, which can take
a moment for a large game server; the dialog shows **Preparing export…** until
it's ready.

A backup kept on the Relay downloads straight from the Relay. When your browser
can't reach the Relay, the download goes through Hearth. See
[Connections](/relays/connections#relays-reached-through-hearth).

### Share a temporary link

To let someone else download a backup, or to fetch it from another machine:

1. In the download dialog, set how long the link should last, in **Minutes** or
   **Hours**, from 1 minute up to 7 days.
2. Choose **Get URL**, then copy the link.

Anyone with the link can download the backup until it expires.

> [!CAUTION]
> A backup can hold passwords, tokens, and player data. Share links only with
> people you'd give that to, and keep their lifetime short.

From the command line, `kiln backup download <backup-id>` saves a backup without
printing its link.

## Delete a backup

Choose the delete button in the backup's row, then **Delete backup**. This
removes the backup and every stored copy of it, and can't be undone. To delete
several at once, select their rows and delete them together.

When the Relay a backup came from has been removed from Hearth, the button reads
**Forget backup** instead. Forgetting removes the backup from Hearth's list and
leaves any stored files alone.
