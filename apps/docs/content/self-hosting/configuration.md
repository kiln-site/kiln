---
title: Configuration
description: The environment variables a platform Relay, Hearth, and every Relay read, and how to change them.
---

Kiln is configured with environment variables on the Relay's container. On the
machine that runs Hearth, set everything on the platform Relay: it passes
Hearth's settings on to Hearth and generates the rest, including every secret.

## Change a setting

A setting changes when the Relay's container is recreated with the new
environment, on the same `kiln-relay-data` volume. On its next pass the
platform Relay recreates Hearth with the new settings, keeping the version
Kiln's updates moved it to. The database and cache keep theirs.

With [Compose](/get-started/install#install-with-compose), edit `.env` and run:

```sh
docker compose up -d
```

The install script doesn't keep a settings file. To see the settings it
started the Relay with:

```sh
docker inspect kiln-relay --format '{{range .Config.Env}}{{println .}}{{end}}'
```

To change them, you can move that Relay to Compose. Kiln's
[`compose.yaml`](https://github.com/kiln-site/kiln/blob/main/compose.yaml) uses
the same container and volume names as the install script:

1. Put `compose.yaml` and an `.env` from
   [`.env.example`](https://github.com/kiln-site/kiln/blob/main/.env.example)
   in a folder. In `.env`, set `KILN_URL`, `KILN_PLATFORM_PROXY`, and any other
   setting to what `docker inspect` showed, plus your change. If you installed
   with `--nightly`, also set `KILN_IMAGE_TAG=latest-nightly`.
2. Remove the old container. The volume, and everything Kiln keeps in it,
   stays:

   ```sh
   docker rm -f kiln-relay
   ```

3. Start it again with Compose:

   ```sh
   docker compose up -d
   ```

> [!WARNING]
> Keep the `kiln-relay-data` volume. Starting a platform Relay on an empty
> volume installs a new, empty Kiln.

## Platform Relay

Set these on the Relay that installed Kiln.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KILN_URL` | Required on first start | Where people open Hearth, such as `https://kiln.example.com` or `http://203.0.113.10:3000`. Saved; later starts may change it. |
| `KILN_PLATFORM_PROXY` | `traefik` with the install script and Compose, `none` otherwise | What serves Hearth over HTTPS: `traefik` runs Traefik on ports 80 and 443 for an `https://` `KILN_URL`; `coolify` labels Hearth for Coolify's proxy; `none` serves it only at its own port |
| `KILN_PLATFORM_HEARTH_PORT` | `3000` | Host port for Hearth, without HTTPS |
| `KILN_PLATFORM_HEARTH_BIND` | `0.0.0.0` | Host address for Hearth's port |
| `KILN_RELAY_GAME_HOST` | The host in `KILN_URL` | Where players connect to game servers |
| `KILN_SFTP_PORT` | `2022` | Host port for SFTP. Compose only; the install script takes `--sftp-port`. |
| `KILN_RELAY_ACME_CA_SERVER` | Let's Encrypt | Another ACME directory for Traefik, such as Let's Encrypt's staging one |
| `KILN_RELAY_RESOURCE_NAMESPACE` | None | Prefix for every container, volume, and network, to run beside another Kiln on the same machine |
| `KILN_RELAY_CONTAINER` | Found by the Relay | The Relay's own container name, where it can't find it itself, as with Podman or Docker in Docker |
| `KILN_IMAGE_PREFIX` | `ghcr.io/kiln-site` | Compose only: where to pull the Relay from |
| `KILN_IMAGE_TAG` | `latest` | Compose only: the Relay's tag. `latest-nightly` follows nightly builds. |

These take effect only on the platform Relay's first start. Afterwards it uses
what it saved:

| Variable | Default | Meaning |
| --- | --- | --- |
| `KILN_PLATFORM_HEARTH_IMAGE` | Hearth with the Relay's own tag | Hearth's image. Kiln's updates change it afterwards. |
| `KILN_PLATFORM_DATABASE_IMAGE` | `mysql:8.4` | The database's image. A database engine is never swapped under its data. |
| `KILN_PLATFORM_CACHE_IMAGE` | `valkey/valkey:9.1.2-alpine` | The cache's image; `none` runs Hearth without a cache |
| `KILN_INSTALLATION_ID` | Generated | The installation's ID |
| `BETTER_AUTH_SECRETS` | Generated | Hearth's signing and encryption secret, for moving an existing Hearth here |
| `KILN_PLATFORM_BACKUP_KEY` | Generated | Encrypts Kiln's backups. The recovery kit holds it. |

## Hearth

Set these on the platform Relay too; it passes them on to Hearth.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KILN_ENABLE_SIGNUPS` | `false` | Let anyone who can open Hearth create an account |
| `KILN_SUPER_USER_EMAIL`, `KILN_SUPER_USER_PASSWORD` | None | Create the first administrator with this email and password, instead of through the setup link. Set both; the password needs 12 to 128 characters. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | None | Send email, such as invitations and password resets, through [Resend](https://resend.com). Set both. |
| `KILN_MARKETING_URL` | `https://kiln.site` | Your own site, for the Terms and Privacy links in Hearth and the install script that **Add Relay**'s command downloads |
| `MCLOGS_API_URL` | mclo.gs | Another [mclo.gs](https://mclo.gs)-compatible service for sharing logs |
| `BETTER_AUTH_URL` | `KILN_URL` | The address sign-in runs at, when it differs from `KILN_URL` |
| `BETTER_AUTH_TRUSTED_ORIGINS` | None | More origins allowed to sign in, separated by commas |
| `TZ` | None | Hearth's time zone, such as `Europe/Berlin` |
| `OTEL_*` | See [Telemetry](/self-hosting/telemetry) | OpenTelemetry export |

Without email, people you invite get a setup link from an administrator
instead of an email.

## Every Relay

These work on any Relay, on the machine that runs Hearth or any other.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KILN_RELAY_GAME_HOST` | The Relay's address | Where players connect to this Relay's game servers. `public-ip` finds the machine's public IPv4 address. |
| `KILN_RELAY_GAME_PORT_RANGE` | `30000-39999` | Ports game servers get, such as `25565-25600` |
| `KILN_RELAY_HOST_ACCESS` | `true` | `false` turns off the Relay's terminal on its machine |
| `KILN_RELAY_ALLOW_PROVISIONING` | `true` | `false` stops new game servers on this Relay, and hides it when people add one |
| `KILN_RELAY_CRASH_RETRY_LIMIT` | `2` | Times the Relay restarts a game server that crashes, from 0 to 10 |
| `KILN_RELAY_CRASH_RETRY_DELAY_SECONDS` | `5` | Seconds between those restarts |
| `KILN_RELAY_CRASH_STABILITY_SECONDS` | `300` | How long a game server must run before its crash count resets |
| `KILN_BACKUP_TIMEOUT` | `60` | Minutes a backup may run before it's stopped |
| `KILN_RELAY_ACME_EMAIL` | None | Email for Let's Encrypt, when the Relay runs Traefik |
| `DOCKER_CONFIG` | `/root/.docker` | Folder holding a Docker `config.json` with registry logins, for private images |
| `OTEL_*` | See [Telemetry](/self-hosting/telemetry) | OpenTelemetry export |

> [!NOTE]
> `docker login` on the machine doesn't reach the Relay, since Docker keeps
> logins on the client. To pull private images, mount a `config.json` with the
> credentials written inline under `auths` into the Relay's container, and
> point `DOCKER_CONFIG` at its folder. Credential helpers don't work.
