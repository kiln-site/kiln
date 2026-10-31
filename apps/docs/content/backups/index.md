---
title: Backups
description: Back up game servers, databases, and Kiln itself, on the Relay or in S3-compatible storage, by hand or on a schedule.
---

Each Relay backs up what runs on it. Open **Backups** in the sidebar.

| Target          | The backup holds                                                                 |
| --------------- | -------------------------------------------------------------------------------- |
| **Game server** | Its folder, minus your exclusions.                                               |
| **Database**    | A dump of MySQL, MariaDB, or PostgreSQL. Redis and Valkey aren't backed up yet.  |
| **Kiln**        | Hearth's database, encrypted. See [Kiln's own backups](/backups/restore#kilns-own-backups). |

Instances keep running during a backup, so a game server's files can be caught
mid-save. Stop it first for a clean backup.

Game server backups are **Incremental** by default: deduplicated snapshots that
store only what changed, to one destination. **Full archive** makes a zip and can
go to several. Database and Kiln backups are full archives.

## Destinations

Backups stay on the Relay (**Local**) or go to S3-compatible storage, such as
Amazon S3, Backblaze B2, MinIO, or Ceph. A backup only on the Relay is lost with
its disk, so keep important ones in S3 too.

To add a bucket:

1. Open **Backups → Destinations** and choose **Add S3 destination**.
2. Enter the **Name**, **Region**, **Endpoint**, **Bucket**, optional **Object
   prefix**, **Access key ID**, and **Secret access key**.
3. Turn on **Path-style URLs** for MinIO and others that don't use the bucket as
   a subdomain.
4. Choose **Verify and save**. Hearth tests the key first.

A destination is yours alone. Kiln Admins can make it a **Platform destination**
for everyone and for Kiln's backups (only when adding it), and allow a
**Private network** endpoint.

> [!WARNING]
> Incremental backups give the key to the Relay. Use a key limited to Kiln's
> bucket or prefix.

Full archives in S3 are capped at 5 GiB. Backups queued before a key rotation
fail; run them again.

## Make a backup

1. In **Backups**, choose **New Backup**.
2. Choose the **Target**, and for a game server, the **Mode**.
3. Under **Destinations**, leave **Default** or pick them yourself.
4. Choose **Create backup**.

It appears in **Runs**, where you can cancel it while it's queued or running.
If the Relay is offline, it starts on reconnect. A backup past 60 minutes is
cancelled; set `KILN_BACKUP_TIMEOUT` (minutes) on the Relay to change it.

To copy a full archive to another S3 destination, choose **+** in its row.

Deleting a game server offers **Back up server before deleting**. Retention never
deletes that backup.

## Schedules

Add a **Backup** action to a schedule in **Automations → Schedules**, and choose
**Configure Backup** for its mode and destination. See
[Schedules](/game-servers/schedules).

## Retention and settings

Open **Backups → Settings** and choose an instance:

- **Retention** keeps the **Newest backups**, up to a **Total space**, for an
  **Age** in days. Blank means no limit. The newest backup is always kept.
- **Destination** sets where **Default** backups go.
- **Exclusions** leave game server paths out, `.gitignore` style, such as
  `cache/**`.

Setting retention needs permission to delete backups. Kiln Admins also set a
**Platform ceiling** the owner can't exceed, and can turn off **Allow backups**.

The [CLI](/cli/commands) lists, creates, downloads, restores, and deletes backups.
