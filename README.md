# Kiln

Kiln is a self-hosted platform for running game servers. Hearth is the web panel that manages them; Relay is the agent that runs on each host.

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

## Configuration

Start from `.env.hearth.example`. These are the values worth setting for a first install:

```env
KILN_URL=https://hearth.example.com
DB_PASSWORD=
BETTER_AUTH_SECRETS=1:
KILN_PLATFORM_BACKUP_KEY=

KILN_RELAY_HOST=relay.example.com
KILN_RELAY_GAME_HOST=games.example.com
KILN_RELAY_GAME_PORT_RANGE=30000-39999
KILN_RELAY_BOOTSTRAP_TOKEN=
KILN_RELAY_PROXY=none
KILN_RELAY_ACME_EMAIL=

KILN_ENABLE_SIGNUPS=false
```

Generate secrets with `openssl rand -base64 48`. `BETTER_AUTH_SECRETS` is versioned (`1:<secret>`). Keep an offline copy of `KILN_PLATFORM_BACKUP_KEY`; it is intentionally separate from Hearth's live secrets so a platform bundle remains recoverable after Hearth is lost. For a colocated Compose stack, give Hearth and Relay the same bootstrap token so they can pair on first boot. Set `KILN_RELAY_PROXY` to `traefik` or `coolify` when an edge should terminate TLS; `none` leaves that to you.

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
back as it was if that fails. To set it up yourself instead, start the stack
below with `docker compose -f compose.yaml -f compose.host-files.yaml up -d`.
Recreating the Relay from a Compose file without it removes the mount. Saving a
host file overwrites it in place, as editors do, so its hard links and
containers that bind-mount it see the change. Where Docker is rootless, remaps
users, or SELinux confines the Relay, the Files page says which files it can't
reach. Links with absolute targets resolve inside the Relay's container, so the
Files page refuses to open them.

Then:

```sh
docker compose up -d
```

## Development

Requires Node 20+, pnpm, Docker, and OrbStack.

```sh
vp install --frozen-lockfile
pnpm dev:setup
pnpm dev:docker
```

`dev:setup` only needs to run once per clone. Open the OrbStack URL printed by `dev:docker` to use the panel.

## License

AGPL-3.0 with an optional [Commercial License](./COMMERCIAL_LICENSE.md). See [LICENSE](./LICENSE). Contributors must sign the [CLA](./CLA.md) — details in [CONTRIBUTING.md](./CONTRIBUTING.md).

Copyright © 2026 Marco Technology Consulting Inc. (“QuartzDev”).
