# Self-hosting

Kiln needs only Docker. One Relay in **platform mode** installs the rest of
Kiln on its own host (Hearth, Hearth's MySQL database, and a Valkey cache),
pairs with that Hearth, and keeps them running. Every other machine runs a
plain Relay that you pair from Hearth.

## Install

On the machine that will host Hearth:

```sh
curl -fsSL https://kiln.site/install | sh
```

The script asks where people will open Hearth (by default
`http://<public IP>:3000`), starts the Relay, waits for Hearth, and prints a
setup link. Open it to create the platform administrator. Pass `--url`,
`--port`, `--game-host`, or `--nightly` to skip the questions, and `--help`
for the rest. Running it again prints the installation's status and setup link.

The script runs one container:

```sh
docker run --detach --name kiln-relay --restart unless-stopped \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume kiln-relay-data:/data \
  --publish 2022:2022 \
  --env KILN_RELAY_MODE=platform \
  --env KILN_URL=https://kiln.example.com \
  ghcr.io/kiln-site/relay:latest
```

`kiln-relay-data` is the installation: it holds the Relay's state, Kiln's
generated secrets, and the record of what the Relay installed. Back it up, or
at least export the recovery kit (see [Recovery](#recovery)).

### Adding machines

On each other machine:

```sh
curl -fsSL https://kiln.site/install | sh -s -- --node
```

It starts a Relay that publishes ports 4100 and 2022 and prints a pairing
invitation. In Hearth, open **Relays**, choose **Add Relay**, and paste it.
Hearth must be able to reach the machine on port 4100.

## Platform mode

`KILN_RELAY_MODE` is `node` (the default) or `platform`. Platform mode adds
to what a Relay does; it still runs game servers, Apps, and databases.

On its first start in platform mode the Relay writes
`/data/platform/installation.json` before it creates anything. The record
holds the installation ID, every secret Kiln needs (Hearth's database
passwords, Better Auth's secret, the Relay bootstrap token, the setup code,
and the platform backup key), the images it chose, and the settings below. A
Relay interrupted partway through installing picks up where it stopped with
the same secrets and volumes.

Then, every 30 seconds, it makes sure these exist and run, on a Docker network
of their own:

| Container          | Image                                | Notes                                                                                |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------ |
| `kiln-hearth-mysql` | `mysql:8.4`                          | Data in the `kiln-hearth-mysql` volume                                               |
| `kiln-hearth-cache` | `valkey/valkey:9.1.2-alpine`         | In memory only                                                                       |
| `kiln-hearth`       | Hearth with the Relay's own tag      | Published on `KILN_PLATFORM_HEARTH_BIND:KILN_PLATFORM_HEARTH_PORT`; pairs on startup |

The Relay joins that network under its own host name (`kiln-relay` unless
`KILN_RELAY_HOST` says otherwise), the name its certificate is issued for, and
Hearth connects to it there. Browsers reach the Relay through Hearth
(`KILN_RELAY_PROXY=hearth`), so the Relay publishes no port of its own besides
SFTP. With `KILN_RELAY_RESOURCE_NAMESPACE`, every name above is prefixed with
it.

Containers carry the same `io.kiln.installation` and `io.kiln.resource` labels
as the Compose stack, so platform backups and Kiln's updates work as they do
there, plus `io.kiln.platform.role` and a hash of their settings.

### Settings

Set these on the Relay. Everything else is generated.

| Variable                       | Default                    | Meaning                                                                    |
| ------------------------------ | -------------------------- | -------------------------------------------------------------------------- |
| `KILN_URL`                     | Required on first start    | Where people open Hearth. Saved; later starts may change it.               |
| `KILN_PLATFORM_HEARTH_PORT`    | `3000`                     | Host port for Hearth                                                       |
| `KILN_PLATFORM_HEARTH_BIND`    | `0.0.0.0`                  | Host address for Hearth's port                                             |
| `KILN_RELAY_GAME_HOST`         | The host in `KILN_URL`     | Where players connect to game servers                                      |
| `KILN_PLATFORM_HEARTH_IMAGE`   | Hearth with the Relay's tag | First start only; Kiln's updates change it afterwards                      |
| `KILN_PLATFORM_DATABASE_IMAGE` | `mysql:8.4`                | First start only; a database engine is never swapped under its data        |
| `KILN_PLATFORM_CACHE_IMAGE`    | `valkey/valkey:9.1.2-alpine` | First start only; `none` runs Hearth without a cache                      |
| `KILN_RELAY_CONTAINER`         | Found and proven           | The Relay's own container, where it can't find it (Podman, Docker in Docker) |
| `KILN_INSTALLATION_ID`         | Generated                  | First start only                                                           |
| `BETTER_AUTH_SECRETS`          | Generated                  | First start only; for moving an existing Hearth here                       |
| `KILN_PLATFORM_BACKUP_KEY`     | Generated                  | First start only; encrypts platform backups, and the recovery kit holds it |

These are passed on to Hearth when set on the Relay: `KILN_ENABLE_SIGNUPS`,
`KILN_MARKETING_URL`, `KILN_SUPER_USER_EMAIL`, `KILN_SUPER_USER_PASSWORD`,
`RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `MCLOGS_API_URL`, `BETTER_AUTH_URL`,
`BETTER_AUTH_TRUSTED_ORIGINS`, `TZ`, and the `OTEL_*` variables.

Changing a setting means recreating the Relay's container with the new
environment. On its next pass the Relay recreates Hearth with the new
settings, keeping the image Kiln's updates moved it to. The database and cache
are recreated only if their own settings change, which after the first start
they don't.

### Safeguards

- **It installs only on a new Relay.** A Relay that has paired with a Hearth or
  adopted an installation ID keeps running as a plain Relay and logs why.
  Switching an existing Relay to platform mode never creates a second
  installation.
- **Turning platform mode off doesn't remove anything.** A Relay that installed
  Kiln but starts without `KILN_RELAY_MODE=platform` leaves Hearth and its
  database alone and logs that it does.
- **It never replaces lost data with an empty database.** Once the database has
  existed, a missing `kiln-hearth-mysql` volume stops the Relay from going on
  until an operator runs `kiln-relay platform recover`.
- **It joins only itself to Kiln's network.** It takes the container Docker
  mounts its hostname from as a candidate, then has Docker confirm that
  container holds a file it just wrote to the root of its own filesystem,
  which no container sharing its network or volumes has. It never goes by name or
  hostname, and joins nothing when it can't prove it.
- **It touches only its own containers.** A container, volume, or network with
  one of its names that isn't labeled for its installation stops it with a
  message instead.
- **It leaves updates alone.** The Relay changes a container only while
  holding the same lock, taken the same way, that Kiln's updater takes to
  replace it, so a pass never recreates, starts, or stops a container
  mid-update, and an update waits for a repair to finish.
- **Maintenance holds.** While `stop-hearth` holds Hearth stopped, passes keep
  it stopped, restarts and Kiln's updates refuse to start it, and `stop-hearth`
  itself fails rather than claim success while an update still holds Hearth.
  On a Relay that installed Kiln, `kiln-relay platform-backup restore` runs
  only in maintenance, holding Hearth's update lock throughout.
- **One change at a time.** The running Relay and `kiln-relay platform`
  commands take an exclusive lock in the data volume that the kernel holds
  for the process and releases if it dies, so nothing ever times out or is
  taken over.
- **Only the Hearth it installed manages them.** Restart and repair requests
  are accepted only from a Hearth client that paired through an invitation the
  Relay made for its own Hearth. Another Hearth paired with the same Relay can
  run game servers there but can't touch Kiln's services or read their logs.
- **Setup needs the setup code.** Hearth starts with `KILN_SETUP_TOKEN`, and
  only someone with the setup link can create the first administrator, so
  publishing a new Hearth doesn't race strangers to it.
- **A paused Relay leaves them alone.** Its passes wait in its
  [operation lanes](relay-operations.md) like any other change. Docker's
  restart policy still restarts a container that exits.

None of this limits someone with access to the Docker socket, which is root on
the host.

## In Hearth

**Infrastructure → System**, for platform administrators, shows Hearth, its
database, and its cache as the Relay beside them reports them: state, image,
version, and their last 500 log lines. With a Relay that installed them it also
restarts each one and repairs them (the same pass the Relay runs every 30
seconds). Hearth and its database deployed with Compose or Coolify appear
read-only, labeled as deployed outside Kiln, when a Relay runs on their host.

Hearth updates from the Updates dialog as with Compose.

## On the Relay's host

`kiln-relay platform` works without Hearth:

| Command                  | Does                                                                        |
| ------------------------ | --------------------------------------------------------------------------- |
| `status`                 | Shows the installation and each service                                     |
| `setup-url`              | Prints the setup link                                                       |
| `repair`                 | Runs a pass now, even while the Relay is paused                             |
| `stop-hearth`            | Holds Hearth stopped; the database and cache keep running                   |
| `start-hearth`           | Lets Hearth run again                                                       |
| `recover --confirm <id>` | Starts an empty database after its volume was lost, holding Hearth stopped |
| `export-kit`             | Prints the recovery kit                                                     |
| `import-kit <path>`      | Installs from a recovery kit on a new Relay                                 |
| `pair`                   | Prints an invitation for the installed Hearth, such as after a restore     |

Run them with `docker exec kiln-relay kiln-relay platform <command>`. If the
Relay itself won't start, run them from a recovery container on the same
volume:

```sh
docker run --rm -it --entrypoint kiln-relay \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume kiln-relay-data:/data \
  ghcr.io/kiln-site/relay:latest platform status
```

## Recovery

A [platform backup](backups.md) holds Hearth's catalog. The recovery kit holds
what isn't in it: the installation ID and every secret, including the
platform backup key that decrypts those backups. Export it after installing,
and keep it offline, apart from the backups:

```sh
docker exec kiln-relay kiln-relay platform export-kit > kiln-recovery.json
```

Anyone with the kit can read Kiln's database and sign Hearth sessions.

To restore Kiln on a new host, import the kit into the new Relay's data volume
before the Relay's first start, so it doesn't install a new installation:

```sh
docker volume create kiln-relay-data
docker run --rm --entrypoint kiln-relay \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume kiln-relay-data:/data \
  --volume "$PWD/kiln-recovery.json:/kit.json:ro" \
  ghcr.io/kiln-site/relay:latest platform import-kit /kit.json
```

Then start the Relay as [Install](#install) shows, with the same `KILN_URL`.
It creates an empty database and holds Hearth stopped. Restore the platform
backup into it and start Hearth:

```sh
docker cp backup.zip kiln-relay:/data/restore.zip
docker exec kiln-relay kiln-relay platform-backup restore /data/restore.zip \
  --confirm <installation-id>
docker exec kiln-relay kiln-relay platform start-hearth
```

The new Relay has a new identity, and the restored Hearth still lists the old
one at the same address. Remove the old Relay from **Relays** first, then pair
the new one there with the invitation `kiln-relay platform pair` prints, which
also lets that Hearth restart and repair Kiln's services.

When only the database volume is lost on the same host, run
`kiln-relay platform recover --confirm <installation-id>`, restore a platform
backup, and run `start-hearth`.

## Existing Compose and Coolify installs

They keep working as before, and **System** shows their Hearth and database
read-only. To move one under a platform Relay:

1. Create a platform backup of it, and note its `KILN_INSTALLATION_ID`,
   `BETTER_AUTH_SECRETS`, and `KILN_PLATFORM_BACKUP_KEY`. Hearth encrypts
   saved credentials with `BETTER_AUTH_SECRETS`, so the new Hearth needs the
   same value to read them.
2. Start a platform Relay on a fresh data volume with those three variables
   set, along with `KILN_RELAY_MODE=platform` and `KILN_URL`. On its first
   start it uses them instead of generating its own.
3. Once Hearth is up, run `kiln-relay platform stop-hearth`, restore the backup
   with `kiln-relay platform-backup restore`, and run `start-hearth`.
4. Stop the old deployment, so two tools don't manage the same Hearth. If
   Hearth lists its colocated Relay at the same address as the new one, remove
   it from Relays, then pair the new Relay with `kiln-relay platform pair`.

`KILN_INSTALLATION_ID`, `BETTER_AUTH_SECRETS`, and `KILN_PLATFORM_BACKUP_KEY`
only matter on that first start; afterwards the Relay uses its saved record.
