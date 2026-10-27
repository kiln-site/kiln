---
title: Backups
description: Back up game servers, databases, and Kiln itself, on the Relay or in S3-compatible storage, by hand or on a schedule.
---

Kiln backs up game servers, databases, and Kiln itself. Each Relay makes the
backups for what runs on it, and keeps them on its own disk or uploads them to
S3-compatible storage. Open **Backups** in the sidebar to see and manage them.

## What gets backed up

| Target          | What the backup holds                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| **Game server** | Its whole folder, apart from the paths you exclude.                                                            |
| **Database**    | A compressed dump of a MySQL, MariaDB, or PostgreSQL database. Redis and Valkey databases aren't backed up yet. |
| **Kiln**        | Hearth's own database, encrypted. Only Kiln Admins see it. See [Kiln's own backups](/backups/platform).        |

Game servers and databases keep running while they're backed up. A running game
server's files can change mid-backup, so the backup is a best effort, as if the
machine had lost power at that moment. A file that changes while it's read is
tried again once, and if it changes again, the backup lists it as a warning.
For a backup with no chance of half-saved files, stop the game server first.

## Where backups go

- **Local Relay** keeps the backup on the Relay that runs the game server or
  database. It's always available.
- **S3** uploads it to an S3-compatible bucket, such as Amazon S3, Backblaze B2,
  MinIO, or Ceph. See [Destinations](/backups/destinations).

A backup kept only on the Relay is lost if the machine's disk is. Keep important
backups in S3 too.

## Incremental and full backups

Game server backups have two modes:

- **Incremental**, the default, saves deduplicated snapshots. Each backup stores
  only what changed since the last, so frequent backups of a large world stay
  small. An incremental backup goes to one destination.
- **Full archive** saves a portable zip of the whole folder. It can go to several
  destinations at once.

Database and Kiln backups are always full archives. Downloading any backup gives
you the complete file, whichever mode made it.

## Make a backup

1. Open **Backups**. **Runs** lists every backup you can see.
2. Choose **New Backup**.
3. Choose the **Target**, and change the **Name** if you like.
4. For a game server, choose the **Mode**.
5. Under **Destinations**, choose **Default** for the target's preferred
   destination, or pick **Local** and any **S3** destinations yourself.
6. Choose **Create backup**.

The backup appears in **Runs** and updates as it goes: **Queued**, **Scanning
files**, **Archiving**, **Uploading**, and so on. Each Relay makes one backup at a
time, in order. While one is queued or running, you can cancel it from its row.

If the Relay is offline, Hearth saves the request, and the backup starts once the
Relay reconnects. A backup that runs longer than 60 minutes is cancelled. Set
`KILN_BACKUP_TIMEOUT` on the Relay, in minutes, to change it.

## Back up on a schedule

Scheduled backups are a schedule action. Open **Automations → Schedules**,
create or edit a schedule, add a **Backup** action, and choose **Configure
Backup** to pick its mode and destination.

Kiln creates one schedule for itself: **Kiln backups**, which backs Kiln up every
day at 03:00 UTC. See [Kiln's own backups](/backups/platform).

## Backup settings

Each game server, database, and Kiln has its own backup settings. Open
**Backups → Settings** and choose an instance.

- **Retention** keeps the **Newest backups**, up to a **Total space**, for an
  **Age** in days. Leave a field blank for no limit on it.
- **Destination** sets where **Default** backups go: **This Relay** or one of
  your S3 destinations.
- **Exclusions**, for game servers, leaves paths out of backups, one pattern per
  line, in `.gitignore` style, such as `cache/**` or `logs/*.log`.

Choose **Save** to apply them.

Hearth deletes backups past the retention, oldest first, soon after a backup
finishes, and every ten minutes. It always keeps the newest backup, so retention
never leaves an instance with none. Setting retention needs permission to delete
backups as well as create them.

Kiln Admins also see a **Platform ceiling**: limits the owner's retention can't
pass. Turning off **Allow backups** there turns backups off for that instance.

## Copy a backup to another destination

Each backup row lists where it's available. To add a copy in another S3
destination, choose **+** beside the list. Incremental backups can't be copied to
S3.

## Before deleting a game server

Deleting a game server offers **Back up server before deleting**, with a
**Backup destination**. Kiln makes that backup first and deletes the server only
once the backup has succeeded. Retention never deletes these final backups.

## From the command line

The `kiln` CLI lists, creates, downloads, restores, and deletes backups:

```sh
kiln backups targets
kiln backups create server <relay-id>:<instance-id> --name "Before update"
kiln backups list
kiln backup download <backup-id>
kiln backup restore <backup-id>
```
