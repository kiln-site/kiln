# Self-hosting

Kiln needs only Docker, and its installer sets that up too. One Relay in **platform mode** installs the rest of
Kiln on its own host (Hearth, Hearth's MySQL database, and a Valkey cache),
pairs with that Hearth, and keeps them running. Every other machine runs a
plain Relay that you pair from Hearth.

## Install

On the machine that will host Hearth:

```sh
curl -fsSL https://kiln.site/install | sh
```

If Docker isn't installed, the script offers to install it: with Docker's
official script (get.docker.com) on Debian, Ubuntu, Fedora, CentOS, RHEL,
Raspberry Pi OS, and SLES, from Docker's CentOS packages on Rocky, AlmaLinux,
and Oracle Linux, and with the system's package manager on Alpine and Arch. It
starts Docker and enables it at boot, uses `sudo` when your user can't reach
Docker's socket, and checks Docker by its version (20 or newer) and by running
`hello-world` before installing Kiln. Without a terminal to ask on, it installs
Docker only with `--yes`; `--skip-docker-install` stops instead. On macOS,
install Docker Desktop first.

The script asks its questions first, so the rest runs unattended: whether to
install Docker, and where people will open Hearth. Kiln is served over HTTPS
by default:

- **Traefik** (`--proxy traefik`, the default). The Relay runs Traefik on ports
  80 and 443 in front of Hearth. Press Enter for `https://<public IP>`, with a
  six-day Let's Encrypt certificate for the address that Traefik renews, or
  type a domain that already points at the machine for `https://<domain>`.
- **Coolify** (`--proxy coolify`, chosen on its own when `coolify-proxy` is
  running). Hearth gets labels for Coolify's Traefik and its Let's Encrypt
  resolver. Coolify's resolver can't issue for an address, so type a domain;
  pressing Enter keeps `http://<public IP>:3000`.
- **None** (`--proxy none`). When another program already has port 80 or 443
  the script asks before using `http://<public IP>:3000` instead.

Hearth stays published on its own port (3000) either way. It then shows one
line per step with a timer, starts the Relay, waits for Hearth and for HTTPS,
and prints a setup link. Open it to create
the platform administrator. Everything each step ran and printed goes to
`~/kiln-install.log` (or `KILN_INSTALL_LOG`); a failed step names it. Pass `--url`,
`--port`, `--game-host`, or `--nightly` to skip the questions, and `--help`
for the rest. Running it again prints the installation's status and setup link.

The script runs one container, `kiln-relay`, on the `kiln-relay-data`
volume. [`compose.yaml`](../compose.yaml) runs the same container with
Compose, for those who keep their services there: copy `.env.example` to
`.env`, set `KILN_URL`, then

```sh
docker compose up -d
docker exec kiln-relay kiln-relay platform setup-url
```

The second prints the setup link the installer would. Either way the Relay
installs and updates the rest; don't run Hearth, its database, or the Relay
by hand, since that drifts from what Kiln sets up and supports.

`kiln-relay-data` is the installation: it holds the Relay's state, Kiln's
generated secrets, and the record of what the Relay installed. Back it up, or
at least export the recovery kit (see [Recovery](#recovery)).

### Adding machines

In Hearth, open **Relays** and choose **Add Relay**. It shows a command to
run on the new machine:

```sh
curl -fsSL https://kiln.site/install | sh -s -- --join 'https://kiln.example.com/#kj1.<code>'
```

The link carries Hearth's address and a code that lasts 30 minutes (**New
command** in the dialog makes another and retires the old). When ports 80
and 443 are free, the Relay runs its own Traefik on them, like a platform
install, and Kiln reaches it at `https://<public IP>` with a Let's Encrypt
certificate (the six-day one for an IP address). Apps on that machine get
their domains and HTTPS from the same Traefik. The installer waits for the
certificate before the Relay announces itself to Hearth. When Let's Encrypt
can't reach the machine on port 80, as when a router sends 80 and 443 to
another machine, the installer offers to use port 4100 instead. When
something else already has 80 or 443, or the machine has no curl to check
HTTPS with, the Relay uses port 4100 and its own certificate from the
start: `--proxy none` asks for that.

Once the Relay announces itself, the installer prints a link to confirm it
in Hearth, which opens the dialog on that Relay, and its fingerprint, which
the dialog shows too. Until Hearth can reach the Relay, the dialog says
where it tried and waits. Confirming takes an optional name; left blank,
the Relay gets the next free default name (K100, then K101, and so on). The
machine must be able to reach Hearth at `KILN_URL`, and Hearth the machine:
on 443 behind Traefik, or 4100, at its public IP, with a router forwarding
the port. For another address, such as a domain or an internal address,
add `--relay-host <address>` to the command; for another SFTP port, add
`--sftp-port <port>`. The installer stops before starting anything when a
port it needs is taken, and names what has it. A machine whose Relay data
is already there keeps the way it was reached.

The install command is the supported way to add a machine: it sets up the
Relay's container, volume, and settings the way Kiln expects and keeps them
that way across updates, so a machine set up by hand can drift from what
Kiln supports.

- **Pairing link** pairs a Relay that's already running without a join:
  run `docker exec kiln-relay kiln-relay pair create` on it and paste what
  it prints.
- On a machine that already runs a Relay, the install command joins that
  Relay instead (`kiln-relay pair join '<link>'`), and Hearth reconnects it
  if it already has it.

Joining needs the Relay's own HTTPS (the default). The link's secret never
leaves the two machines: the Relay proves it holds it, and Hearth answers
in kind, so the dialog asks first when Hearth's address is plain HTTP,
where someone on the network could still get in the way.

#### Installation IDs

A Relay takes the installation ID of the first Hearth that pairs it and
keeps it. Another Hearth pairing the same Relay, as when two Kiln
installations share one machine, is asked whether to replace the Relay's ID
with its own or keep it. The ID decides whose Kiln services and backups the
Relay finds; it doesn't separate anything else, since every Hearth paired
with full access can manage the Relay. `KILN_INSTALLATION_ID`, or a Relay
that installed Kiln itself, fixes the ID.

### The CLI

To manage Kiln from a terminal, install the `kiln` command on your own
computer (Linux or macOS), then sign in with your Kiln's address:

```sh
curl -fsSL https://kiln.site/install | sh -s -- --cli
kiln login https://kiln.example.com
```

It needs no Docker. See [the CLI's README](../apps/cli/README.md#install) for
where it goes, `--nightly`, and other ways to install it.

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

| Container           | Image                           | Notes                                                                                |
| ------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| `kiln-hearth-mysql` | `mysql:8.4`                     | Data in the `kiln-hearth-mysql` volume                                               |
| `kiln-hearth-cache` | `valkey/valkey:9.1.2-alpine`    | In memory only                                                                       |
| `kiln-hearth`       | Hearth with the Relay's own tag | Published on `KILN_PLATFORM_HEARTH_BIND:KILN_PLATFORM_HEARTH_PORT`; pairs on startup |

The Relay joins that network under its own host name (`kiln-relay` unless
`KILN_RELAY_HOST` says otherwise), the name its certificate is issued for, and
Hearth connects to it there. Browsers reach the Relay through Hearth
(`KILN_RELAY_PROXY=hearth`), so the Relay publishes no port of its own besides
SFTP. With `KILN_RELAY_RESOURCE_NAMESPACE`, every name above is prefixed with
it.

With `KILN_PLATFORM_PROXY=traefik` and an `https://` `KILN_URL` on the default
port, the Relay also runs `kiln-traefik` on ports 80 and 443 and joins it to
that network. It routes the host in `KILN_URL` to Hearth with a Let's Encrypt
certificate: from the six-day profile, and served by default, when the host
is an IP address, since browsers send no name for one. The Relay itself
stays in `hearth` proxy mode. If the ports are taken, the Relay logs it and
Hearth is still at its own port.

Containers carry Kiln's `io.kiln.installation` and `io.kiln.resource` labels,
which platform backups and Kiln's updates find them by, plus
`io.kiln.platform.role` and a hash of their settings.

### Settings

Set these on the Relay. Everything else is generated.

| Variable                       | Default                      | Meaning                                                                                                   |
| ------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `KILN_URL`                     | Required on first start      | Where people open Hearth. Saved; later starts may change it.                                              |
| `KILN_PLATFORM_HEARTH_PORT`    | `3000`                       | Host port for Hearth                                                                                      |
| `KILN_PLATFORM_PROXY`          | `none`                       | `traefik` runs Traefik on 80 and 443 for an https `KILN_URL`; `coolify` labels Hearth for Coolify's proxy |
| `KILN_RELAY_ACME_CA_SERVER`    | Let's Encrypt                | Another ACME directory for Traefik, such as Let's Encrypt's staging one                                   |
| `KILN_PLATFORM_HEARTH_BIND`    | `0.0.0.0`                    | Host address for Hearth's port                                                                            |
| `KILN_RELAY_GAME_HOST`         | The host in `KILN_URL`       | Where players connect to game servers                                                                     |
| `KILN_PLATFORM_HEARTH_IMAGE`   | Hearth with the Relay's tag  | First start only; Kiln's updates change it afterwards                                                     |
| `KILN_PLATFORM_DATABASE_IMAGE` | `mysql:8.4`                  | First start only; a database engine is never swapped under its data                                       |
| `KILN_PLATFORM_CACHE_IMAGE`    | `valkey/valkey:9.1.2-alpine` | First start only; `none` runs Hearth without a cache                                                      |
| `KILN_RELAY_CONTAINER`         | Found and proven             | The Relay's own container, where it can't find it (Podman, Docker in Docker)                              |
| `KILN_INSTALLATION_ID`         | Generated                    | First start only                                                                                          |
| `BETTER_AUTH_SECRETS`          | Generated                    | First start only; for moving an existing Hearth here                                                      |
| `KILN_PLATFORM_BACKUP_KEY`     | Generated                    | First start only; encrypts platform backups, and the recovery kit holds it                                |

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
seconds). Hearth, its database, and its cache deployed with Compose or Coolify
appear read-only, labeled with what manages them, when a Relay runs on their
host.

Hearth updates from the Updates dialog as with Compose.

## On the Relay's host

`kiln-relay platform` works without Hearth:

| Command                  | Does                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| `status`                 | Shows the installation and each service                                    |
| `setup-url`              | Prints the setup link                                                      |
| `repair`                 | Runs a pass now, even while the Relay is paused                            |
| `stop-hearth`            | Holds Hearth stopped; the database and cache keep running                  |
| `start-hearth`           | Lets Hearth run again                                                      |
| `recover --confirm <id>` | Starts an empty database after its volume was lost, holding Hearth stopped |
| `export-kit`             | Prints the recovery kit                                                    |
| `import-kit <path>`      | Installs from a recovery kit on a new Relay                                |
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

## Kiln's pages

Platform administrators open Kiln itself from the **Kiln** button beside
**Updates** in Infrastructure, like any other instance:

- **Info** shows Hearth, its database, its cache, and the Traefik in front of
  them, with Repair, a Restart for each, and the `kiln-relay platform`
  commands to run on the host when Hearth itself is down. Its **Data** section
  exports Hearth's database as SQL, imports such an export back, and opens its
  backups; the rail's **Backups** line counts them. An import puts back
  every table's rows in one transaction, so it takes effect whole or not at
  all, and requests wait on it meanwhile. It takes only a whole, unchanged
  export (Kiln seals each with a SHA-256 of its contents; up to 32 MB) from the same version of Kiln, whose tables have the
  same shape, and only when a Kiln backup from the last day exists to come
  back to.
- **Viewer** browses and edits Hearth's tables through the Relay, with the
  login Hearth itself uses. It needs a Relay with `relay-platform-database-v1`.
- **Logs** follows each container's output live.
- **Terminal** opens a shell in the database, the cache, or the Traefik the
  Relay runs. Hearth's image has no shell.

Restarts and shells are only for an installation the Relay installed, from the
Hearth it installed. A Traefik that Coolify or something else runs shows as
managed elsewhere: its logs, but no restart or shell. These need a Relay with
`relay-platform-v2`; older ones show the latest log lines only.

## Installs that run Hearth by hand

Kiln once documented running Hearth, its database, its cache, and a Relay as
separate Compose services or Coolify resources. Set up new installs with the
installer or `compose.yaml` instead, which run one platform Relay that sets
up and updates the rest. Installs made the old way keep working, and Kiln's
own pages (the **Kiln** button beside **Updates** in Infrastructure) show
their Hearth, database, cache, and any Traefik in front of them read-only:
their logs, but no restarts or shells.

A Relay on the same Docker host finds them by Kiln's labels
(`io.kiln.installation` and `io.kiln.resource`, which Kiln's old Compose file
set), or else from Hearth itself. Each time Hearth connects it names the container it
runs in, proven with an HMAC keyed by its `BETTER_AUTH_SECRETS`, which the
Relay checks against that container's environment. The Relay then finds the
database and cache that Hearth's `DB_HOST` and `CACHE_HOST` name on a Docker
network Hearth shares with them, so Hearth, MySQL, and Valkey deployed as
separate Coolify resources show up without any labels. Kiln's backups use the
same containers. The Relay saves which ones they were, so it can still
restore a backup after Coolify removes Hearth's container to stop it, and it
refuses while any container with Hearth's `BETTER_AUTH_SECRETS` runs.

### From Kiln's old compose.yaml

`compose.yaml` used to be that stack, and now runs one platform Relay
instead, so it isn't an upgrade of an install started from the old file.
Pulling it and running `docker compose up -d` leaves the old stack running:
the new Relay is a service of another name (`kiln-relay`), and it stops on
the ports the old one holds. Remove the container it made with
`docker rm -f kiln-relay`, then either:

- **Keep running it as before.** Save the old file and use it from now on:

  ```sh
  git show 18b90d3:compose.yaml > compose.legacy.yaml
  docker compose -f compose.legacy.yaml up -d
  ```

- **Move it under a platform Relay**, as below.

### Moving under a platform Relay

1. Create a platform backup of it, and note its `KILN_INSTALLATION_ID`,
   `BETTER_AUTH_SECRETS`, and `KILN_PLATFORM_BACKUP_KEY`. Hearth encrypts
   saved credentials with `BETTER_AUTH_SECRETS`, so the new Hearth needs the
   same value to read them.
2. Start a platform Relay on a fresh data volume with those three variables
   set, along with `KILN_URL`. On its first start it uses them instead of
   generating its own. With Compose, put all four in `.env` and start
   `compose.yaml`; the Relay reads everything in `.env`. A custom SFTP
   port from the old `.env` (`KILN_RELAY_SFTP_PORT`) becomes
   `KILN_SFTP_PORT`. On the same machine, stop the old deployment first,
   since the new one needs its ports.
3. Once Hearth is up, run `kiln-relay platform stop-hearth`, restore the backup
   with `kiln-relay platform-backup restore`, and run `start-hearth`.
4. Stop the old deployment, so two tools don't manage the same Hearth. If
   Hearth lists its colocated Relay at the same address as the new one, remove
   it from Relays, then pair the new Relay with `kiln-relay platform pair`.

`KILN_INSTALLATION_ID`, `BETTER_AUTH_SECRETS`, and `KILN_PLATFORM_BACKUP_KEY`
only matter on that first start; afterwards the Relay uses its saved record.

A platform backup recreates the database it came from by name, and the
platform Relay's database is named `hearth`, so restore refuses a backup of
a database named anything else (Coolify's MySQL defaults to `default`). Move
such an installation with Kiln's SQL export instead, which carries only its
tables: on the old Hearth, **Export SQL** from Kiln's Info page; once the new
Hearth runs the same version, upload that file into its **Data** section.

## Known rough edges

To come back to:

- In Hearth, a Relay that installed Kiln shows its address as `kiln-relay:4100`,
  its name on Kiln's private network, and its consoles and logs show "Connected
  through Hearth · Direct Relay unavailable". Both are how platform mode is meant
  to work (browsers reach the Relay through Hearth), but they read like
  problems.
