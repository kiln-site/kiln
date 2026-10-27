---
title: Install Kiln
description: Run the install script on the machine that will host Hearth, then open the setup link to create the administrator.
---

Kiln needs only Docker, and the install script sets that up too. Run it on the
Linux machine that will host Hearth:

```sh title="On the machine that will run Hearth"
curl -fsSL https://kiln.site/install | sh
```

When it finishes, it prints a link. Open it to create your administrator
account.

## Requirements

- **Linux.** If Docker is missing, the script offers to install it on Debian,
  Ubuntu, Fedora, CentOS, RHEL, Raspberry Pi OS, SLES, Rocky Linux, AlmaLinux,
  Oracle Linux, Alpine, and Arch. On macOS, install Docker Desktop first.
- **Docker 20 or newer.** The script checks the version and runs
  `hello-world` before it installs Kiln. It uses `sudo` when your user can't
  reach Docker's socket.
- **Free ports.** Kiln serves HTTPS on ports 80 and 443 by default. Hearth also
  listens on port 3000, and SFTP on port 2022. Game servers get public ports
  from 30000 to 39999.

## Run the installer

The script asks its questions first, then runs on its own:

1. **Install Docker**, if it isn't installed.
2. **Where people will open Kiln.** Press <kbd>Enter</kbd> for
   `https://<public IP>`, or type a domain that already points at the machine
   for `https://<domain>`.

It then shows one line per step with a timer, starts the Relay, waits for
Hearth and for HTTPS, and prints the setup link.

How Kiln is served over HTTPS depends on what's already on the machine:

| Proxy | Chosen | What happens |
| --- | --- | --- |
| Traefik | By default | The Relay runs Traefik on ports 80 and 443 in front of Hearth, with a Let's Encrypt certificate for your domain, or a six-day one for the IP address. |
| Coolify | When Coolify's proxy is running | Hearth gets labels for Coolify's Traefik. Type a domain; pressing <kbd>Enter</kbd> keeps `http://<public IP>:3000`. |
| None | When another program has port 80 or 443 | The script asks before using `http://<public IP>:3000` instead. |

Hearth stays on port 3000 either way. HTTPS can take a few minutes after the
install; until then, the script tells you to use `http://<address>:3000`.

> [!NOTE]
> Everything each step ran and printed goes to `~/kiln-install.log`. When a
> step fails, the script names it and points you to the log.

## Create the administrator

Open the setup link the script printed. The **Set up Kiln** page asks for:

- **Display Name**
- **Email**
- **Password**
- **Confirm password**

Choose **Create administrator**. Only someone with the setup link can create
the first account, so publishing a new Kiln doesn't race strangers to it.

If you lost the link, print it again on the machine:

```sh
docker exec kiln-relay kiln-relay platform setup-url
```

Running the install script again also prints the installation's status and
the setup link.

## What it sets up

The script runs one container, `kiln-relay`, on a volume named
`kiln-relay-data`. That Relay runs in **platform mode**: it installs the rest
of Kiln beside itself and keeps it running.

| Container | Runs |
| --- | --- |
| `kiln-relay` | The Relay, which also runs game servers, apps, and databases on this machine |
| `kiln-hearth` | Hearth, the web panel |
| `kiln-hearth-mysql` | Hearth's MySQL database |
| `kiln-hearth-cache` | A Valkey cache for Hearth |
| `kiln-traefik` | Traefik on ports 80 and 443, when Kiln is served through it |

The Relay installs and updates the rest, so don't run Hearth, its database, or
the Relay by hand. See [Self-hosting](/self-hosting) for how platform mode
works.

> [!CAUTION]
> The `kiln-relay-data` volume holds the installation, including Kiln's
> generated secrets. Export the recovery kit after installing and keep it
> offline. See [Recovery](/self-hosting/recovery#export-the-recovery-kit).

## Installer options

Pass options after `sh -s --`:

```sh
curl -fsSL https://kiln.site/install | sh -s -- --url https://kiln.example.com
```

| Option | Does |
| --- | --- |
| `--url URL` | Where people will open Kiln. Default: `https://<this machine's public IP>` |
| `--proxy MODE` | `traefik`, `coolify`, or `none` |
| `--port PORT` | Host port Hearth also listens on, without HTTPS. Default: `3000` |
| `--game-host HOST` | Address players connect to game servers at. Default: the host in `--url` |
| `--bind ADDRESS` | Host address Hearth's port listens on. Default: all |
| `--sftp-port PORT` | Host port for SFTP. Default: `2022` |
| `--nightly` | Install the newest nightly instead of the newest stable release |
| `--namespace NAME` | Prefix for every container, volume, and network, to run beside another Kiln on the same machine |
| `--skip-docker-install` | Stop instead of installing Docker when it's missing |
| `-y`, `--yes` | Don't ask; use the defaults, and install Docker if it's missing |
| `--help` | Show every option |

Without a terminal to ask on, the script installs Docker only with `--yes`.

## Install with Compose

If you keep your services in Compose, Kiln's
[`compose.yaml`](https://github.com/kiln-site/kiln/blob/main/compose.yaml)
runs the same Relay in platform mode. Copy
[`.env.example`](https://github.com/kiln-site/kiln/blob/main/.env.example) to
`.env`, set `KILN_URL` to where people will open Kiln, then:

```sh
docker compose up -d
docker exec kiln-relay kiln-relay platform setup-url
```

The second command prints the setup link. Any setting from
[Configuration](/self-hosting/configuration) can go in `.env`.

> [!WARNING]
> If you started Kiln from an older `compose.yaml` that ran Hearth, MySQL, and
> Valkey as their own services, this file isn't an upgrade of that stack. Read
> [Moving from the old compose.yaml](/self-hosting/recovery#moving-from-the-old-composeyaml)
> first.

## Next steps

- [Create your first game server](/get-started/first-game-server) on this
  machine.
- To run things on other machines, open **Relays** in Hearth and choose
  **Add Relay**. See [Add a Relay](/relays/add).
- To manage Kiln from a terminal, install the `kiln` command on your own
  computer (Linux or macOS). It needs no Docker:

  ```sh title="On your computer"
  curl -fsSL https://kiln.site/install | sh -s -- --cli
  kiln login https://kiln.example.com
  ```
