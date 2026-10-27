---
title: Restore
description: Restore or download a backup, share a link to one, and back up and restore Kiln itself.
---

Every backup in **Backups → Runs** can be restored, downloaded, or deleted from
its row.

## Restore a backup

Restoring replaces the game server's files or the database's contents.

1. Stop the game server. Databases can stay running.
2. In **Backups → Runs**, choose **Restore** on the backup.
3. Leave **Safety backup** on to back up the current state first.
4. Choose **Restore backup**.

If the restore fails, the game server's folder is left as it was. If the Relay is
offline, the restore starts when it reconnects.

## Download a backup

Choose the download button, pick the **Source**, and choose **Download**.
Incremental backups are zipped first, which can take a while.

To share it, set how long a link lasts, up to 7 days, and choose **Get URL**.
Anyone with the link can download it.

> [!CAUTION]
> Backups can hold passwords, tokens, and player data. Keep links short-lived.

**Delete backup** removes every stored copy and can't be undone.

## Kiln's own backups

A Kiln backup holds Hearth's database: users, Relays, instances, permissions,
schedules, and settings. Only Kiln Admins see them. The **Kiln backups** schedule
runs daily at 03:00 UTC and keeps 30 days, up to 20 GiB, on the Relay. They can
go only to a [platform destination](/backups#destinations).

Restoring one needs the recovery kit, which no backup holds. To export the kit,
restore Kiln, or rebuild it on a new machine, see
[Updates and recovery](/self-hosting/updates#restore-kiln).
