---
title: Kiln's own backups
description: Back up Hearth's database and settings, keep the recovery kit that unlocks them, and restore Kiln from a backup.
---

Kiln backs itself up like any game server or database. A Kiln backup holds
Hearth's database: your users, Relays, instances, permissions, schedules, and
settings. Only Kiln Admins can see, make, and restore these backups.

In pickers and in **Backups → Runs**, Kiln's backups show as **Kiln**. They're
made by the Relay that runs beside Hearth.

## The daily backup

A new installation backs Kiln up every day at 03:00 UTC, with a schedule named
**Kiln backups**. It keeps the backups on the Relay, for 30 days, in at most
20 GiB. Edit or delete the schedule in **Automations → Schedules**, and change
the retention in **Backups → Settings** under **Kiln**.

To keep Kiln's backups off the machine, send them to a platform S3 destination.
Kiln's backups can only go to [platform destinations](/backups/destinations#personal-and-platform-destinations).

To back Kiln up now, choose **New Backup** in **Backups → Runs** and choose
**Kiln** as the target.

## Keep the recovery kit

Kiln's backups are encrypted with Kiln's platform backup key. The backup alone
can't be restored without it. The key, the installation ID, and Kiln's other
secrets are in the recovery kit, which isn't part of any backup.

Export the recovery kit after installing, and keep it offline, apart from the
backups:

```sh title="On the machine that runs Hearth"
docker exec kiln-relay kiln-relay platform export-kit > kiln-recovery.json
```

> [!CAUTION]
> Anyone with the recovery kit can read Kiln's database and sign in as anyone.
> Store it like a root password.

## Restore Kiln

Hearth can't replace its own database while it runs, so Kiln restores with
Hearth stopped, from the Relay's machine. Game servers, apps, and databases keep
running, and everyone's pages reconnect once Hearth is back, usually within a
minute.

1. In **Backups → Runs**, choose **Restore** on the Kiln backup.
2. The **Restore Kiln** dialog shows the command to run on the Relay's machine.
   When the Relay installed Kiln, choose **Open in terminal**: it opens the
   Relay's [terminal](/relays/host#terminal) with the command typed for you.
3. Check the command and run it.

When the Relay installed Kiln, the command stops Hearth, restores the backup, and
starts Hearth again:

```sh title="On the machine that runs Hearth"
docker exec kiln-relay kiln-relay platform stop-hearth && \
  docker exec kiln-relay kiln-relay platform-backup restore /data/backups/<backup-id>.zip --confirm <installation-id> && \
  docker exec kiln-relay kiln-relay platform start-hearth
```

When Hearth runs some other way, such as with Compose or Coolify, stop Hearth
there first, run only the `platform-backup restore` command with your Relay's
container name, then start Hearth again.

If the backup isn't on the Relay, as when it's only in S3,
[download it](/backups/restore#download-a-backup) and copy it into the Relay's
container first:

```sh title="On the machine that runs Hearth"
docker cp backup.zip kiln-relay:/data/restore.zip
```

The dialog's command then restores `/data/restore.zip`.

### What the restore checks

- It refuses a backup from another Kiln installation. `--confirm` takes the
  installation ID the backup belongs to; to read it from a backup, run
  `kiln-relay platform-backup inspect <file>`.
- It verifies the backup hasn't been changed before it replaces anything.
- It refuses to run while Hearth's container is running.

## Restore on a new machine

When the machine that ran Hearth is gone, restore onto a new one with the
recovery kit and a Kiln backup.

1. Import the recovery kit into a new Relay volume, before the Relay first
   starts:

   ```sh title="On the new machine"
   docker volume create kiln-relay-data
   docker run --rm --entrypoint kiln-relay \
     --volume /var/run/docker.sock:/var/run/docker.sock \
     --volume kiln-relay-data:/data \
     --volume "$PWD/kiln-recovery.json:/kit.json:ro" \
     ghcr.io/kiln-site/relay:latest platform import-kit /kit.json
   ```

2. Start the Relay the way you first installed Kiln, with the same Kiln address.
   It creates an empty database and holds Hearth stopped.
3. Copy the backup in, restore it, and start Hearth:

   ```sh title="On the new machine"
   docker cp backup.zip kiln-relay:/data/restore.zip
   docker exec kiln-relay kiln-relay platform-backup restore /data/restore.zip \
     --confirm <installation-id>
   docker exec kiln-relay kiln-relay platform start-hearth
   ```

4. The new Relay has a new identity, and the restored Hearth still lists the old
   one. In **Infrastructure → Relays**, remove the old Relay, then pair the new
   one with the link `docker exec kiln-relay kiln-relay platform pair` prints.
