---
title: Recovery
description: Keep a recovery kit and backups of Kiln, restore them on the same or a new machine, and fix a self-hosted install that won't come up.
---

To bring Kiln back after losing its machine, you need two things: a backup of
Hearth's database, and the recovery kit with the secrets that unlock it. Kiln
makes the backups on its own; the recovery kit is yours to export and keep.

## Export the recovery kit

The recovery kit holds what Kiln's backups don't: the installation ID and every
secret, including the key that decrypts the backups. Export it after
installing:

```sh title="On the machine that runs Hearth"
docker exec kiln-relay kiln-relay platform export-kit > kiln-recovery.json
```

Keep it offline, apart from the backups.

> [!CAUTION]
> Anyone with the recovery kit can read Kiln's database and sign Hearth's
> sessions.

## Kiln's backups

Kiln backs itself up like any game server or database. A new installation
gets a **Kiln backups** schedule that backs Kiln up every day at 03:00 UTC to
the Relay beside Hearth, and keeps 30 days of backups in at most 20 GiB. Each
backup holds Hearth's database, encrypted with the key in the recovery kit.

Only platform administrators can back up Kiln, by hand or on a schedule. See
[Kiln's backups](/backups/platform).

A backup of Kiln doesn't hold your game servers', apps', or databases' own
data. Back those up separately.

## Restore a backup

Restoring Kiln runs with Hearth stopped, on the Relay's machine. In Hearth,
**Restore** on one of Kiln's backups shows the commands, and on the platform
Relay it opens the Relay's terminal with them typed for you.

1. Hold Hearth stopped:

   ```sh
   docker exec kiln-relay kiln-relay platform stop-hearth
   ```

2. Find the installation ID the backup belongs to:

   ```sh
   docker exec kiln-relay kiln-relay platform-backup inspect /data/backups/<backup-id>.zip
   ```

3. Restore it:

   ```sh
   docker exec kiln-relay kiln-relay platform-backup restore /data/backups/<backup-id>.zip \
     --confirm <installation-id>
   ```

4. Start Hearth again:

   ```sh
   docker exec kiln-relay kiln-relay platform start-hearth
   ```

The restore checks the backup before it replaces anything, and refuses a backup
from another installation.

## Move to a new machine

1. On the new machine, import the recovery kit into a new data volume before
   the Relay's first start, so it doesn't install a new, empty Kiln:

   ```sh title="On the new machine"
   docker volume create kiln-relay-data
   docker run --rm --entrypoint kiln-relay \
     --volume /var/run/docker.sock:/var/run/docker.sock \
     --volume kiln-relay-data:/data \
     --volume "$PWD/kiln-recovery.json:/kit.json:ro" \
     ghcr.io/kiln-site/relay:latest platform import-kit /kit.json
   ```

2. Start the Relay as [Install Kiln](/get-started/install) shows, with the same
   `KILN_URL`. It creates an empty database and holds Hearth stopped.
3. Copy a backup in, restore it, and start Hearth:

   ```sh
   docker cp backup.zip kiln-relay:/data/restore.zip
   docker exec kiln-relay kiln-relay platform-backup restore /data/restore.zip \
     --confirm <installation-id>
   docker exec kiln-relay kiln-relay platform start-hearth
   ```

4. The restored Hearth still lists the old machine's Relay. In **Relays**,
   remove the old one, then choose **Add Relay** and paste the invitation this
   command prints into **Pairing link**:

   ```sh
   docker exec kiln-relay kiln-relay platform pair
   ```

   Pairing this way also lets Hearth restart and repair Kiln's services.

## Lost database volume

If only the `kiln-hearth-mysql` volume is lost, the Relay stops rather than
start an empty database. On the same machine:

1. Start an empty database, with Hearth held stopped:

   ```sh
   docker exec kiln-relay kiln-relay platform recover --confirm <installation-id>
   ```

2. Restore a backup, as in [Restore a backup](#restore-a-backup).
3. Run `start-hearth`.

## Troubleshooting

### The install script failed

The script names the step that failed. Everything each step ran and printed is
in `~/kiln-install.log`. When a port it needs is taken, it stops before
starting anything and names what has it.

Running the script again on a machine that has Kiln prints the installation's
status and setup link instead of installing again.

### Hearth won't load

On the Relay's machine, check Kiln's services:

```sh
docker exec kiln-relay kiln-relay platform status
```

To create what's missing and start what stopped, now rather than at the
Relay's next pass:

```sh
docker exec kiln-relay kiln-relay platform repair
```

If the Relay itself won't start, run these from a recovery container, as
[Self-hosting](/self-hosting#on-the-relays-machine) shows.

### HTTPS doesn't work

Traefik needs ports 80 and 443. If something else has them, the Relay logs it
and Hearth stays at its own port, `http://<address>:3000`. A new Let's Encrypt
certificate can take a few minutes. Kiln's **Info** page shows whether Traefik
answers.

### The setup link is lost

```sh
docker exec kiln-relay kiln-relay platform setup-url
```

### The Relay beside Hearth looks unreachable

In Hearth, the Relay that installed Kiln shows its address as
`kiln-relay:4100`, and its consoles say "Connected through Hearth · Direct
Relay unavailable". Both are expected: browsers reach that Relay through
Hearth.

## Moving from the old compose.yaml

Kiln's `compose.yaml` used to run Hearth, MySQL, Valkey, and a Relay as
services of their own. It now runs one platform Relay instead, so it isn't an
upgrade of an install started from the old file. Pulling it and running
`docker compose up -d` leaves the old stack running, and the new Relay stops on
the ports the old one holds.

If you did that, remove the new container:

```sh
docker rm -f kiln-relay
```

Then either keep running the old stack, or move it under a platform Relay.

### Keep running it as before

Save the old file and use it from now on:

```sh
git show 18b90d3:compose.yaml > compose.legacy.yaml
docker compose -f compose.legacy.yaml up -d
```

It keeps working, and Kiln's **Info** page shows its Hearth, database, and
cache read-only: their logs, but no restarts or shells.

### Move it under a platform Relay

1. Back up Kiln on the old install, and note its `KILN_INSTALLATION_ID`,
   `BETTER_AUTH_SECRETS`, and `KILN_PLATFORM_BACKUP_KEY`. The new Hearth needs
   the same `BETTER_AUTH_SECRETS` to read the credentials it saved.
2. Start a platform Relay on a fresh data volume with those three variables
   and `KILN_URL`. With Compose, put all four in `.env`. A custom SFTP port
   from the old `.env` (`KILN_RELAY_SFTP_PORT`) becomes `KILN_SFTP_PORT`. On
   the same machine, stop the old stack first, since the new one needs its
   ports.
3. Once Hearth is up, run `stop-hearth`, restore the backup with
   `platform-backup restore`, and run `start-hearth`.
4. Stop the old stack for good, so two tools don't manage the same Hearth. If
   Hearth lists the old Relay at the same address as the new one, remove it
   from **Relays**, then pair the new one with `kiln-relay platform pair`.

The three variables matter only on that first start. Afterwards the Relay uses
its saved record.

> [!NOTE]
> A backup restores into a database of the same name, and the platform Relay's
> is named `hearth`. If the old database had another name, such as Coolify's
> default `default`, move it with an SQL export instead: choose **Export SQL**
> on the old Kiln's **Info** page, and once the new Hearth runs the same
> version, import the file in its **Data** section. An import needs a backup
> of the new Kiln from the last day, to come back to.
