---
title: Self-hosting
description: How a self-hosted Kiln runs, how to install it with Compose, and the settings Hearth and Relays read.
---

A self-hosted Kiln is one Relay in **platform mode** that installs Hearth beside
itself and keeps it running. Other machines run plain Relays you add from
Hearth. To install, see [Get started](/#install).

## What runs where

| Container | Runs |
| --- | --- |
| `kiln-relay` | The platform Relay, which also runs instances on this machine |
| `kiln-hearth` | Hearth, the web panel |
| `kiln-hearth-mysql` | Hearth's MySQL database |
| `kiln-hearth-cache` | Valkey, Hearth's cache |
| `kiln-traefik` | Traefik, serving Hearth over HTTPS on ports 80 and 443 |

The `kiln-relay-data` volume holds the installation and Kiln's secrets.
[Export the recovery kit](/self-hosting/updates#export-the-recovery-kit) after
installing.

The platform Relay recreates any of these that changed or went missing. It
won't install on a Relay already paired with a Hearth, never replaces a lost
database with an empty one, and stops rather than touch a container with one of
its names that isn't its own.

Browsers reach this Relay through Hearth, so **Relays** shows it as
`kiln-relay:4100` with "Direct Relay unavailable". That's expected.

Platform administrators manage these containers from **Kiln**, beside
**Updates** at the top of Infrastructure pages: restart and **Repair** them,
follow logs, open a shell, browse Hearth's tables, and export or import its
database as SQL.

## Install with Compose

Kiln's [`compose.yaml`](https://github.com/kiln-site/kiln/blob/main/compose.yaml)
runs the same platform Relay as the install script. Copy
[`.env.example`](https://github.com/kiln-site/kiln/blob/main/.env.example) to
`.env`, set `KILN_URL`, then print the setup link:

```sh
docker compose up -d
docker exec kiln-relay kiln-relay platform setup-url
```

> [!WARNING]
> If your `compose.yaml` ran Hearth and MySQL as their own services, read
> [Moving from the old compose.yaml](/self-hosting/updates#moving-from-the-old-composeyaml)
> first.

## Change a setting

Set everything on the Relay's container; the platform Relay passes Hearth's
settings on. With Compose, edit `.env` and run `docker compose up -d`.

The install script keeps no settings file. To change one, move to Compose: put
the settings `docker inspect kiln-relay` shows into `.env` with your change
(plus `KILN_IMAGE_TAG=latest-nightly` if you installed with `--nightly`), run
`docker rm -f kiln-relay`, then `docker compose up -d`.

> [!WARNING]
> Keep the `kiln-relay-data` volume. A platform Relay on an empty volume
> installs a new, empty Kiln.

## Configuration

### Platform Relay

| Variable | Default | Meaning |
| --- | --- | --- |
| `KILN_URL` | Required | Where people open Hearth |
| `KILN_PLATFORM_PROXY` | `traefik` | `traefik`, `coolify` (labels Hearth for Coolify's proxy), or `none` |
| `KILN_PLATFORM_HEARTH_PORT` | `3000` | Host port for Hearth without HTTPS |
| `KILN_PLATFORM_HEARTH_BIND` | `0.0.0.0` | Host address for that port |
| `KILN_SFTP_PORT` | `2022` | SFTP port (Compose; the script takes `--sftp-port`) |
| `KILN_RELAY_ACME_CA_SERVER` | Let's Encrypt | Another ACME directory |
| `KILN_RELAY_RESOURCE_NAMESPACE` | None | Name prefix, to run beside another Kiln |
| `KILN_RELAY_CONTAINER` | Found | The Relay's container name, as with Podman |
| `KILN_IMAGE_PREFIX`, `KILN_IMAGE_TAG` | `ghcr.io/kiln-site`, `latest` | Compose: the Relay's image |

Read once, on the first start: `KILN_PLATFORM_HEARTH_IMAGE`,
`KILN_PLATFORM_DATABASE_IMAGE` (`mysql:8.4`), `KILN_PLATFORM_CACHE_IMAGE`
(`none` for no cache), and, to move an existing Hearth here,
`KILN_INSTALLATION_ID`, `BETTER_AUTH_SECRETS`, and `KILN_PLATFORM_BACKUP_KEY`.

### Hearth

Set these on the platform Relay.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KILN_ENABLE_SIGNUPS` | `false` | Let anyone create an account |
| `KILN_SUPER_USER_EMAIL`, `KILN_SUPER_USER_PASSWORD` | None | Create the first administrator; password 12 to 128 characters |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | None | Send email through [Resend](https://resend.com). Without it, invitations are setup links. |
| `KILN_MARKETING_URL` | `https://kiln.site` | Your site, for Terms and Privacy links and **Add Relay**'s script |
| `MCLOGS_API_URL` | mclo.gs | Another log sharing service |
| `BETTER_AUTH_URL` | `KILN_URL` | Where sign-in runs |
| `BETTER_AUTH_TRUSTED_ORIGINS` | None | More sign-in origins, comma-separated |
| `TZ` | None | Time zone, such as `Europe/Berlin` |

### Every Relay

| Variable | Default | Meaning |
| --- | --- | --- |
| `KILN_RELAY_GAME_HOST` | The Relay's address | Where players connect; `public-ip` finds it. The platform Relay uses `KILN_URL`'s host. |
| `KILN_RELAY_GAME_PORT_RANGE` | `30000-39999` | Ports game servers get |
| `KILN_RELAY_HOST_ACCESS` | `true` | `false` turns off the Relay's terminal |
| `KILN_RELAY_ALLOW_PROVISIONING` | `true` | `false` stops new game servers here |
| `KILN_RELAY_CRASH_RETRY_LIMIT` | `2` | Restarts after a crash, 0 to 10 |
| `KILN_RELAY_CRASH_RETRY_DELAY_SECONDS` | `5` | Seconds between them |
| `KILN_RELAY_CRASH_STABILITY_SECONDS` | `300` | Run time that resets the count |
| `KILN_BACKUP_TIMEOUT` | `60` | Minutes a backup may run |
| `KILN_RELAY_ACME_EMAIL` | None | Email for Let's Encrypt |
| `DOCKER_CONFIG` | `/root/.docker` | Folder with a `config.json` holding registry logins inline under `auths` |
| `OTEL_*` | | See [Telemetry](/self-hosting/telemetry) |
