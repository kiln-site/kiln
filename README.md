# Kiln

Kiln is a self-hosted platform for managing apps, databases, and game servers. Hearth is the web panel; Relay is the agent that runs on each host.

## Images

```text
ghcr.io/kiln-site/hearth:latest
ghcr.io/kiln-site/relay:latest
```

Nightly builds are published as `:latest-nightly`. Official Ember runtimes used by Bricks:

```text
ghcr.io/kiln-site/bricks-java:11
ghcr.io/kiln-site/bricks-java:17
ghcr.io/kiln-site/bricks-java:21
ghcr.io/kiln-site/bricks-java:25
ghcr.io/kiln-site/bricks-steamcmd:latest
```

## Forking and publishing

See [Publishing an independent distribution](docs/forking.md) for repository settings,
CLI publishing, self-updates, and merging upstream without workflow patches.

## Install

Kiln needs only Docker. On the machine that will host Hearth:

```sh
curl -fsSL https://kiln.site/install | sh
```

This starts a Relay in platform mode, which installs Hearth, its MySQL
database, and a Valkey cache, pairs with that Hearth, keeps them running, and
prints a link that creates the administrator. To add another machine, choose
**Add Relay** in Hearth and run the command it shows there.

To run the same with Compose, set `KILN_URL` in a `.env` from `.env.example`
and start [`compose.yaml`](compose.yaml), which runs just that Relay:

```sh
docker compose up -d
docker exec kiln-relay kiln-relay platform setup-url
```

If you started Kiln from an older `compose.yaml`, which ran each service
itself, read [From Kiln's old compose.yaml](docs/self-hosting.md#from-kilns-old-composeyaml)
first: this one isn't an upgrade of that stack.

Either way, the Relay sets up and updates everything else, so set Kiln up
one of these two ways rather than running Hearth, its database, or a Relay
by hand. See [Self-hosting](docs/self-hosting.md) for how it works, its
settings, and recovery.

## Relay access

The Relay workspace includes a root terminal on its Docker host, protected by
`relay.terminal`. Set `KILN_RELAY_HOST_ACCESS=false` on the Relay to disable host
access. Its small shell helper is created on first use and removed when host
access is disabled. Each person's session survives page and Hearth reconnects
and closes after the configured terminal idle timeout.

The Files page browses and edits the host's files with the same browser and
editor as server and app files, protected by `relay.files.read` and
`relay.files.write`. It needs the host's filesystem mounted at `/host`. Someone
with `relay.files.mount` (Relay owners and platform admins by default) can turn
that on from the Files page, which restarts the Relay with the mount and puts it
back as it was if that fails. With Compose, start it with
`docker compose -f compose.yaml -f compose.host-files.yaml up -d` instead.
Recreating the Relay from a Compose file without it removes the mount. Saving a
host file overwrites it in place, as editors do, so its hard links and
containers that bind-mount it see the change. Where Docker is rootless, remaps
users, or SELinux confines the Relay, the Files page says which files it can't
reach. Links with absolute targets resolve inside the Relay's container, so the
Files page refuses to open them.

The Database page inspects the live `/data/network/relay.sqlite` file in
read-only mode. `relay.database.read` grants access to its state, including
sensitive configuration. When host files are mounted, `relay.files.read` can
read the same file through Docker's volume directory.

See [Relay runtime](docs/relay-runtime.md) for how the Relay talks to Docker,
how its health check works, and how to read its memory use.

## Development

Requires the Node version in `.node-version`, pnpm/Vite+, and Docker with
Compose v2. OrbStack is optional.

```sh
vp install --frozen-lockfile
pnpm dev:setup
pnpm dev:docker
```

Open the URL printed by `dev:docker`. See the [development guide](docs/development.md)
for worktrees, localhost ports, optional OrbStack HTTPS, and cleanup.

## License

AGPL-3.0 with an optional [Commercial License](./COMMERCIAL_LICENSE.md). See [LICENSE](./LICENSE). Contributors must sign the [CLA](./CLA.md) — details in [CONTRIBUTING.md](./CONTRIBUTING.md).

Copyright © 2026 Marco Technology Consulting Inc. (“QuartzDev”).
