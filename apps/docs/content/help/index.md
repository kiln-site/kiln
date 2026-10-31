---
title: Help
description: Fixes for the problems people hit most, matched to Kiln's messages, and short answers about cost, license, and what Kiln runs on.
---

Find the message you're seeing below. Still stuck? Ask on
[Discord](https://discord.gg/gu76VAtSK5) or open a
[GitHub issue](https://github.com/kiln-site/kiln/issues) with the exact
message and your Kiln version.

## Hearth won't load

On Hearth's machine:

1. Run the installer again, `curl -fsSL https://kiln.site/install | sh`. On
   an existing install it prints the status and setup link instead of
   reinstalling.
2. Check each service: `docker exec kiln-relay kiln-relay platform status`.
3. Repair a service that's down: `docker exec kiln-relay kiln-relay platform repair`.
   The Relay also does this every 30 seconds.
4. If Hearth was held stopped, such as by a restore:
   `docker exec kiln-relay kiln-relay platform start-hearth`.

If `http://<machine's address>:3000` works but your HTTPS address doesn't, the
problem is DNS, the certificate, or your proxy.

If `kiln-relay` won't start, run them from a recovery container:

```sh title="On Hearth's machine"
docker run --rm -it --entrypoint kiln-relay \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume kiln-relay-data:/data \
  ghcr.io/kiln-site/relay:latest platform status
```

A failed install says why in `~/kiln-install.log`.

## A Relay won't pair

| Message                                                    | Fix                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hearth can't reach the Relay at _host:port_.**           | Check the Relay is running and its firewall and router allow the port. Or join with the install command from **Add Relay**, which connects out to Hearth. |
| **Hearth can't find _host_.**                              | Fix the DNS record, or pair with the IP address.                                                                                            |
| **Hostname TLS is untrusted.**                             | The certificate doesn't match or expired; the name may point at another machine.                                                           |
| **Relay URL redirected instead of pairing.**               | A proxy is redirecting, usually HTTP to HTTPS. Let pairing requests through unchanged.                                                     |
| **Cloudflare rejected the origin certificate (526)** or **(525)** | Set Cloudflare's SSL mode to one the Relay's certificate satisfies, or turn off its proxy for that name.                             |
| **Pairing invitation is expired or already used.**         | Pairing links work once, for 15 minutes. Run `kiln-relay pair create` again, or click **New command** in **Add Relay**.                    |
| **Joining needs the Relay's own HTTPS**                    | Run `docker exec kiln-relay kiln-relay pair create` on it and paste the link into **Add Relay** under **Pairing link**.                    |

## A game server won't start

The **Console** shows why it stopped when Kiln knows; `kiln server info` shows
it as `Reason`.

| Message                                                              | Fix                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **The server was stopped by an out-of-memory kill.**                 | Raise the memory limit on **Startup** or with `kiln server startup <server> --memory 6GiB`. |
| **The server process exited with code _n_.**                         | The game quit. Check the console for a wrong version or a broken mod or plugin.            |
| **Waiting for the configured server port to accept connections.**    | Still starting. Big worlds and modpacks take minutes.                                      |
| **Automatic recovery stopped after exhausting its attempts.**        | It kept crashing. Fix the cause in the console, then start it.                             |
| **Docker could not bind a required server port…**                    | Something else uses the port. Free it or choose another.                                   |
| **The Relay ran out of disk space while building this server.**      | Free space on the Relay's machine.                                                         |
| **…all default address pools are in use.**                           | Run `docker network prune`, or add ranges to Docker's `default-address-pools`.             |
| **The Relay does not have permission to use Docker.**                | Restore its access to `/var/run/docker.sock` and restart the Relay.                        |

## Players can't connect

1. Give players the **Public Address** from the game server's **Network**
   page, and check it's running and finished starting.
2. Open its port, from `30000-39999` unless `KILN_RELAY_GAME_PORT_RANGE` says
   otherwise, in the machine's firewall and any cloud firewall, for TCP, UDP,
   or both. Forward it on a home router.
3. Restart after changing ports; changes apply on the next start.

See [Networking](/networking).

## Backups fail

Hearth shows why beside each failed backup.

| Message                                                     | Fix                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **_Provider_ storage cap reached** or **account limit reached** | Raise the cap or quota with your provider before deleting backups, which also uploads a little.     |
| **_Provider_ denied access.**                               | Check the [destination's](/backups) access key, its permissions, and the bucket name.                 |
| **Couldn't reach _provider_.**                              | Check the destination's endpoint and the Relay's network.                                              |
| **The Relay's node ran out of disk space** or **does not have enough free space to stage this backup** | Backups stage on the Relay's machine. Free space there.                      |
| **Backup repository is locked.**                            | Another backup holds the lock. After a Relay restart it expires within 30 minutes.                    |
| **The task ran longer than the Relay's backup timeout.**    | Raise `KILN_BACKUP_TIMEOUT` on the Relay.                                                              |
| **Stop the server before restoring a backup.**              | Stop the game server, then restore.                                                                    |

## CLI problems

Start with `kiln whoami` to check your Kiln and profile.

- **Run `kiln login` or provide KILN_TOKEN.** Run `kiln login` with your
  Kiln's address.
- **This CLI is linked with read-only access.** Run `kiln login` again with
  **Read-only access** off.
- **`sftp_unavailable`.** `files upload` and `download` need the Relay's SFTP
  port reachable from your computer. Publish the port the message names.
- **A file isn't found.** Write `server.properties`, not
  `/data/server.properties`.

## Push notifications don't arrive

Allow notifications for Kiln in the browser's site settings, then click
**Enable push** again. See [Push notifications](/access#push-notifications).

## Is Kiln free?

Yes, self-hosted, with every feature and no limit on Relays or instances.
Paid plans where Kiln hosts Hearth for you are coming soon. See
[pricing](https://kiln.site/pricing).

## What license is Kiln under?

The [AGPL-3.0](https://github.com/kiln-site/kiln/blob/main/LICENSE). You can
use, change, and share Kiln, commercially too, under its terms. To keep
changes private or build a proprietary product, buy the
[Kiln Commercial License](https://github.com/kiln-site/kiln/blob/main/COMMERCIAL_LICENSE.md)
from [contact@kiln.site](mailto:contact@kiln.site).

## What does Kiln run on?

Linux with Docker 20 or newer, on x86-64 or ARM64. The installer sets up
Docker on Debian, Ubuntu, Fedora, CentOS, RHEL, Rocky, AlmaLinux, Oracle
Linux, Raspberry Pi OS, SLES, Alpine, and Arch, and also runs on macOS with
Docker Desktop. Windows can't host, but the [CLI](/cli) runs there. Bricks on
the SteamCMD Ember, which many Steam games use, need x86-64.
