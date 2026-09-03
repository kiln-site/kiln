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

## Install on Linux

Create DNS records for `hearth.example.com` and `relay.example.com`, then run:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://kiln.site/install.sh \
  | sudo KILN_DOMAIN=example.com bash -s -- kiln
```

Use `hearth` instead of `kiln` for a non-game-server-provisioning local Relay,
or `relay` to install a standalone Relay and print its pairing URI. Rerunning the command
repairs and recreates Kiln without replacing saved configuration, database
data, or Relay data. See [the installation guide](docs/installation.md) for
custom hostnames and proxy selection.

## Manual configuration

Start from `.env.hearth.example`. These are the values worth setting for a manual install:

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
