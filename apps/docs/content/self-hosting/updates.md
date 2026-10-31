---
title: Updates and recovery
description: Update Hearth and Relays from Hearth, keep the recovery kit, restore Kiln on a new machine, and fix an install that won't come up.
---

## Update from Hearth

1. On any Infrastructure page, such as **Relays**, choose **Updates**.
2. Choose **Update** on the panel or a Relay, or **Update all**.
3. Choose **Confirm**. The dialog follows each update until it's done.

Each Relay swaps in the new container and puts the old one back if the new one
isn't healthy in time. Game servers keep running. Update the `kiln` command
with `kiln update`.

The install script and `compose.yaml` follow the `latest` tag, the newest
stable [release](https://github.com/kiln-site/kiln/releases). `--nightly`, or
`KILN_IMAGE_TAG=latest-nightly`, follows a nightly built from every change to
`main`.

Hearth can't update a container that runs an exact version, a pinned digest,
or a local build; pin one to stay on it. Hearth's own updates need a Relay on
Hearth's machine.

## Export the recovery kit

Kiln [backs up Hearth's database](/backups) every day, encrypted. The recovery
kit holds the installation ID and every secret, including the backup key.
Export it after installing and keep it offline, apart from the backups:

```sh title="On the machine that runs Hearth"
docker exec kiln-relay kiln-relay platform export-kit > kiln-recovery.json
```

> [!CAUTION]
> Anyone with the recovery kit can read Kiln's database and sign Hearth's
> sessions.

## Restore Kiln

**Restore** on a Kiln backup shows the commands, and on the platform Relay
opens its terminal with them typed:

```sh
docker exec kiln-relay kiln-relay platform stop-hearth
docker exec kiln-relay kiln-relay platform-backup restore /data/backups/<backup-id>.zip \
  --confirm <installation-id>
docker exec kiln-relay kiln-relay platform start-hearth
```

The restore refuses a backup from another installation.

### On a new machine

1. Import the recovery kit before the Relay's first start, so it doesn't
   install an empty Kiln:

   ```sh title="On the new machine"
   docker volume create kiln-relay-data
   docker run --rm --entrypoint kiln-relay \
     --volume /var/run/docker.sock:/var/run/docker.sock \
     --volume kiln-relay-data:/data \
     --volume "$PWD/kiln-recovery.json:/kit.json:ro" \
     ghcr.io/kiln-site/relay:latest platform import-kit /kit.json
   ```

2. [Install Kiln](/#install) with the same `KILN_URL`. It holds Hearth stopped.
3. `docker cp backup.zip kiln-relay:/data/restore.zip`, restore
   `/data/restore.zip` as above, and run `start-hearth`.
4. In **Relays**, remove the old Relay. Choose **Add Relay** and paste what
   `docker exec kiln-relay kiln-relay platform pair` prints into **Pairing
   link**.

### Lost database volume

If `kiln-hearth-mysql` is lost, the Relay stops rather than start an empty
database. Run `platform recover --confirm <installation-id>`, restore a backup,
and run `start-hearth`.

## Troubleshooting

- **Hearth won't load.** `docker exec kiln-relay kiln-relay platform status`
  shows what's wrong; `platform repair` creates what's missing and starts what
  stopped.
- **The Relay won't start.** Run the same commands from a recovery container:

  ```sh
  docker run --rm -it --entrypoint kiln-relay \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume kiln-relay-data:/data \
    ghcr.io/kiln-site/relay:latest platform status
  ```

- **The install script failed.** It names the step and logs to
  `~/kiln-install.log`.
- **HTTPS doesn't work.** Traefik needs ports 80 and 443; without them Hearth
  stays at `http://<address>:3000`. A new certificate can take a few minutes.
- **The setup link is lost.** Run `platform setup-url`.

## Moving from the old compose.yaml

The old `compose.yaml` ran Hearth, MySQL, and Valkey as their own services. The
new one isn't an upgrade; its Relay stops on the old stack's ports. Run
`docker rm -f kiln-relay`, then either keep the old stack:

```sh
git show 18b90d3:compose.yaml > compose.legacy.yaml
docker compose -f compose.legacy.yaml up -d
```

Or move it under a platform Relay:

1. Back up Kiln, and note `KILN_INSTALLATION_ID`, `BETTER_AUTH_SECRETS`, and
   `KILN_PLATFORM_BACKUP_KEY`.
2. Stop the old stack. Start a platform Relay on a fresh volume with those
   three and `KILN_URL`. `KILN_RELAY_SFTP_PORT` becomes `KILN_SFTP_PORT`.
3. [Restore the backup](#restore-kiln), then replace the old Relay as in step 4
   above.

A backup restores only into a database named `hearth`. For another name, such
as Coolify's `default`, use **Export SQL** on the old **Info** page and import
it in the new Hearth's **Data** section once both run the same version.
