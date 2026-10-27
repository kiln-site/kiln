---
title: Troubleshooting
description: Fixes for the problems people hit most, matched to the messages Kiln shows when Hearth, a Relay, a game server, or a backup goes wrong.
---

Find the message you're seeing, or the closest symptom, below.

## Hearth won't load

Hearth runs as a container that its platform Relay, `kiln-relay`, keeps
running. Start on the machine you installed Kiln on.

1. Run the installer again. On an existing install it doesn't reinstall; it
   prints the installation's status and setup link.

   ```sh title="On Hearth's machine"
   curl -fsSL https://kiln.site/install | sh
   ```

2. Ask the Relay how each service is doing:

   ```sh title="On Hearth's machine"
   docker exec kiln-relay kiln-relay platform status
   ```

3. If a service is down, run a repair pass now. The Relay runs one every 30
   seconds on its own.

   ```sh title="On Hearth's machine"
   docker exec kiln-relay kiln-relay platform repair
   ```

4. If Hearth was held stopped, such as during a restore, let it run again:

   ```sh title="On Hearth's machine"
   docker exec kiln-relay kiln-relay platform start-hearth
   ```

Hearth also listens without HTTPS on port 3000 (or the `--port` you
installed with). If `http://<machine's address>:3000` works but your HTTPS
address doesn't, the problem is in front of Hearth: DNS, the certificate, or
your proxy.

If the `kiln-relay` container itself won't start, run the same commands from a
recovery container on its volume:

```sh title="On Hearth's machine"
docker run --rm -it --entrypoint kiln-relay \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume kiln-relay-data:/data \
  ghcr.io/kiln-site/relay:latest platform status
```

The installer writes everything it ran to `~/kiln-install.log`. When an
install step fails, that log says why. To rebuild Kiln on a new machine, see
[Recovery](/self-hosting/recovery).

## A Relay won't pair

See [Add a Relay](/relays/add) for the steps. These are the messages Hearth
shows when pairing fails.

**Hearth can't reach the Relay at _host:port_. If its machine is behind a
router, forward port _port_ to it.**
Hearth got no answer at that address. Check the Relay is running, its
firewall allows the port, and your router forwards it. A Relay that Hearth
can't reach can still join with the install command from **Add Relay**, which
lets the Relay connect to Hearth instead.

**Hearth can't find _host_. Check that its DNS points at the Relay's
machine.**
The name doesn't resolve. Fix the DNS record, or pair with the machine's IP
address.

**Hostname TLS is untrusted. Check that DNS points at your Relay.**
The certificate at that address doesn't match or has expired. This often
means the name points at a different machine.

**Relay URL redirected instead of pairing. Check reverse-proxy SSL settings.**
A proxy in front of the Relay is redirecting, usually from HTTP to HTTPS.
Let pairing requests through unchanged.

**Cloudflare rejected the origin certificate (526)** or **Cloudflare could not
complete the TLS handshake with the origin (525).**
Cloudflare's SSL mode doesn't match the Relay's certificate. Set it to one the
Relay's certificate satisfies, or turn off Cloudflare's proxy for that name.

**Pairing invitation is expired or already used.**
Pairing links from `kiln-relay pair create` work once and expire after 15
minutes. Run it again for a new one. For a join command from **Add Relay**,
click **New command**.

**Joining needs the Relay's own HTTPS (KILN_RELAY_TLS_MODE=managed).**
This Relay doesn't serve its own HTTPS, so it can't join with a link. Pair it
by hand: run `docker exec kiln-relay kiln-relay pair create` on it and
paste the link into **Add Relay** under **Pairing link**.

## A game server won't start or keeps stopping

Open the game server's **Console**. When Kiln knows why it stopped, a warning
above the console says so. `kiln server info` shows the same as `Reason`.

**The server was stopped by an out-of-memory kill.**
The game used more memory than its limit. Raise the memory limit on the
[**Startup**](/game-servers/startup) page, or with `kiln server startup <server> --memory 6GiB`.

**The server process exited with code _n_.**
The game itself quit. Read the console and the logs for its error. A wrong
game version or a broken mod or plugin are common causes.

**Waiting for the configured server port to accept connections.**
The process is running, but the game hasn't opened its port yet. Large
worlds and modpacks can take minutes. If it never finishes, check the
console for errors.

**Automatic recovery stopped after exhausting its attempts.**
Kiln restarted the game server after it crashed, and it kept crashing. Fix the
cause shown in the console, then start it again.

### Creating a game server failed

**Docker could not bind a required server port because it is already in use.**
Another program, or another container, already uses that port on the Relay's
machine. Free it, or choose another port, then create the game server again.

**The Relay ran out of disk space while building this server.**
Free space on the Relay's machine, then try again.

**Docker could not create Kiln's private server network because all default
address pools are in use.**
Docker has run out of network ranges. Remove unused Docker networks with
`docker network prune`, or add ranges to Docker's `default-address-pools`.

**The Relay does not have permission to use Docker.**
The Relay can't reach Docker's socket. Restore its access to
`/var/run/docker.sock` and restart the Relay.

## Players can't connect

1. Copy the address from the game server's **Network** page, under **Public
   Address**, and make sure players use that address and port.
2. Make sure the game server is running and finished starting.
3. Open the port on the Relay's machine. Each game server gets its public
   port from the Relay's range, `30000-39999` unless the Relay's
   `KILN_RELAY_GAME_PORT_RANGE` says otherwise. Allow that port, or the whole
   range, through the machine's firewall and any cloud firewall or security
   group, for the protocol the port uses: TCP, UDP, or both.
4. If the machine is behind a home router, forward the same port to it.
5. After adding or changing a port, restart the game server. Port changes
   apply on the next start.

A Relay that connects out to Hearth because Hearth can't reach it still needs
its game ports reachable by players. See [Ports](/networking/ports).

## Backups fail

Hearth shows why next to each failed backup, and `kiln backups list` prints
it below the table.

**_Provider_ storage cap reached** or **_Provider_ account limit reached.**
Your storage provider refused the upload because the bucket hit a cap or
quota, or the account hit a limit such as a daily transaction cap. Raise it
in the provider's account, such as on Backblaze's Caps & Alerts page, or free
space there. Deleting backups also uploads a little, so raise the cap before
deleting.

**_Provider_ denied access.**
The provider refused the destination's access key. Check the key and its
permissions in the destination's settings. If it says the bucket doesn't
exist, check the bucket name. See [Backup destinations](/backups/destinations).

**Couldn't reach _provider_.**
The Relay couldn't connect to the storage endpoint. Check the destination's
endpoint and the Relay's network.

**The Relay's node ran out of disk space** or **The Relay does not have enough
free space to stage this backup.**
Backups are staged on the Relay's machine before they're stored. Free space
there and try again.

**Backup repository is locked.**
Another backup holds the snapshot repository's lock. If the Relay restarted
during a backup, the lock expires within 30 minutes; try again then.

**The task ran longer than the Relay's backup timeout.**
The backup took longer than `KILN_BACKUP_TIMEOUT` allows. Raise it on the
Relay.

**Stop the server before restoring a backup.**
Game servers must be stopped to restore. Stop it, then restore again.

A backup started while its Relay is offline waits and runs when the Relay
reconnects.

## CLI problems

Start with `kiln whoami` to check which Kiln and profile you're using. See
[CLI commands](/cli/commands).

**Run `kiln login` or provide KILN_TOKEN.**
The profile has no saved sign-in. Run `kiln login` with your Kiln's address.

**This CLI is linked with read-only access.**
The CLI was linked read-only. Run `kiln login` again and leave **Read-only
access** off.

**`sftp_unavailable`.**
`kiln files upload` and `download` use the Relay's SFTP port, which isn't
published or reachable. Publish the port the message names on an address
your computer can reach. `files list`, `read`, and `write` don't use SFTP and
keep working.

**A file isn't found.**
Remote paths start at the game server's root. Write `server.properties`, not
`/server.properties` or `/data/server.properties`.

## Push notifications don't arrive

**Notifications are blocked for Kiln.**
Your browser blocks notifications for Hearth's site. Allow them in the
browser's site settings, then click **Enable push** again in **Settings →
Notifications**.

On iPhone and iPad, push works only after you add Kiln to your Home Screen and
open it from there. See [Notifications](/access/notifications#push-notifications).

## Still stuck

Ask on [Discord](https://discord.gg/gu76VAtSK5) or open an issue on
[GitHub](https://github.com/kiln-site/kiln/issues). Include the exact message,
your Kiln version, and what you did right before.
