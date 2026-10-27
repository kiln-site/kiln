---
title: Self-hosting
description: How a self-hosted Kiln runs: one Relay in platform mode installs Hearth, its database, and its cache, and keeps them running.
---

A self-hosted Kiln is a set of containers on machines you own. One Relay, in
**platform mode**, installs the rest of Kiln on its own machine and looks after
it. Every other machine runs a plain Relay that you add from Hearth.

To set one up, see [Install Kiln](/get-started/install).

## What runs where

On the machine you install Kiln on:

| Container | Runs | Data |
| --- | --- | --- |
| `kiln-relay` | The Relay in platform mode | The `kiln-relay-data` volume |
| `kiln-hearth` | Hearth, the web panel | — |
| `kiln-hearth-mysql` | Hearth's MySQL database | The `kiln-hearth-mysql` volume |
| `kiln-hearth-cache` | Valkey, Hearth's cache | In memory only |
| `kiln-traefik` | Traefik on ports 80 and 443, serving Hearth over HTTPS | — |

Hearth, its database, and its cache share a Docker network of their own. The
Relay joins it, and Hearth reaches the Relay there. Browsers reach this Relay
through Hearth, so it publishes no port besides SFTP.

On every other machine, one `kiln-relay` container runs the game servers, apps,
and databases you put there. See [Add a Relay](/relays/add).

The `kiln-relay-data` volume is the installation. It holds the Relay's state,
Kiln's generated secrets, and the record of what the Relay installed. Back it
up, or at least [export the recovery kit](/self-hosting/recovery#export-the-recovery-kit).

## Platform mode

A Relay runs in platform mode when `KILN_RELAY_MODE` is `platform`. The install
script and Kiln's `compose.yaml` both set it. Platform mode adds to what a
Relay does; it still runs game servers, apps, and databases.

On its first start, the Relay writes down the installation before it creates
anything: an installation ID, every secret Kiln needs, the images it chose,
and its settings. A Relay interrupted partway through installing picks up
where it stopped with the same secrets and volumes.

Then, every 30 seconds, it makes sure Hearth, the database, the cache, and
Traefik exist and run, and recreates any that changed or went missing. Kiln's
updates replace Hearth through the same Relay, and the Relay never undoes an
update or recreates a container mid-update.

### What the Relay won't do

- **Install twice.** It installs only on a new Relay. A Relay that has already
  paired with a Hearth keeps running as a plain Relay and logs why.
- **Remove anything when platform mode is turned off.** It leaves Hearth and
  its database alone and logs that it does.
- **Replace lost data with an empty database.** If the database's volume goes
  missing, the Relay stops until you run `kiln-relay platform recover`. See
  [Recovery](/self-hosting/recovery#lost-database-volume).
- **Touch containers that aren't its own.** A container, volume, or network
  with one of its names that isn't labeled for this installation stops it with
  a message instead.
- **Take orders from another Hearth.** Only the Hearth it installed can restart
  or repair Kiln's services. Another Hearth paired with the same Relay can run
  game servers there, but can't touch Kiln's services or read their logs.

None of this limits someone with access to the Docker socket, which is root on
the machine.

## Kiln's pages in Hearth

Platform administrators open Kiln itself from the **Kiln** button beside
**Updates** at the top of the Infrastructure pages:

- **Info** shows Hearth, its database, its cache, and the Traefik in front of
  them, with **Repair** and a restart for each. It also lists the
  `kiln-relay platform` commands to run on the machine when Hearth itself is
  down. Its **Data** section exports Hearth's database as SQL, imports such an
  export, and opens Kiln's backups.
- **Viewer** browses and edits Hearth's tables.
- **Logs** follows each container's output live.
- **Terminal** opens a shell in the database, the cache, or Traefik. Hearth's
  image has no shell.

## On the Relay's machine

`kiln-relay platform` manages Kiln without Hearth. Run its commands with
`docker exec`:

```sh
docker exec kiln-relay kiln-relay platform status
```

| Command | Does |
| --- | --- |
| `status` | Shows Kiln's services and any problem |
| `setup-url` | Prints the link that creates the administrator |
| `repair` | Creates what's missing and starts what stopped, now, even while the Relay is paused |
| `stop-hearth` | Holds Hearth stopped; its database and cache keep running |
| `start-hearth` | Lets Hearth run again |
| `recover --confirm <id>` | Starts an empty database after its volume was lost, holding Hearth stopped |
| `export-kit` | Prints the recovery kit |
| `import-kit <path>` | Installs from a recovery kit on a new Relay |
| `pair` | Prints an invitation for the installed Hearth, such as after a restore |

While `stop-hearth` holds Hearth stopped, the Relay keeps it stopped, and
restarts and updates refuse to start it.

If the Relay itself won't start, run the same commands from a recovery
container on its volume:

```sh
docker run --rm -it --entrypoint kiln-relay \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume kiln-relay-data:/data \
  ghcr.io/kiln-site/relay:latest platform status
```

## More

- [Configuration](/self-hosting/configuration): the settings Hearth and Relays
  read.
- [Updates](/self-hosting/updates): update Hearth and Relays from Hearth.
- [Recovery](/self-hosting/recovery): backups, the recovery kit, and
  troubleshooting.
- [Telemetry](/self-hosting/telemetry): what Kiln reports, and how to turn it
  off.
- [Publish your own distribution](/self-hosting/forking) of Kiln.
