---
title: Relays
description: Add a Relay to each machine that runs game servers, apps, and databases, and fix pairing errors.
---

A Relay is Kiln's agent on a machine. It runs that machine's game servers, apps,
and databases in Docker, and keeps them running while Hearth is away.

Open **Infrastructure → Relays** to see them. A Relay's pages show its **Info**,
a root **Terminal** and the machine's **Files** (see [Host access](/relays/host)),
its Docker **Volumes**, and its **Logs**.

**Pause** stops all changes, such as power actions, files, and backups, until
**Resume**. **Restart Relay** restarts only the Relay. Both leave game servers
running. **Restart host** reboots the machine and everything on it.

## Add a Relay

You need the **Kiln Admin** or **Relay Creator** platform role.

1. Open **Infrastructure → Relays** and choose **Add Relay**.
2. On the **Install** tab, choose **Copy**.
3. Run the command on the new machine:

   ```sh title="On the new machine"
   curl -fsSL https://kiln.site/install | sh -s -- --join 'https://kiln.example.com/#kj1.<code>'
   ```

4. When the dialog shows the Relay, check its fingerprint matches the one the
   installer printed.
5. Enter a **Name** if you want one, and choose **Add Relay**.

The installer adds Docker if it's missing. The machine must reach Hearth, not
the other way round. The command works for 30 minutes; **New command** makes a
fresh one.

On a machine that already has a Relay, the command joins that Relay. If Hearth
already has it, choose **Reconnect** to keep its instances.

## Installer options

By default the installer picks how the Relay is reached:

- **Ports 80 and 443 free:** the Relay runs Traefik there with a Let's Encrypt
  certificate, which apps on the machine also use.
- **80 or 443 taken:** the Relay serves HTTPS on port 4100.
- **Let's Encrypt can't reach port 80,** as behind a home router: the Relay
  opens no ports and connects to Hearth. See [Connections](/relays/connections).

To choose yourself, add an option:

| Option                   | What it does                                                   |
| ------------------------ | -------------------------------------------------------------- |
| `--proxy traefik`        | Traefik on ports 80 and 443, with a Let's Encrypt certificate. |
| `--proxy none`           | The Relay's own HTTPS on port 4100.                            |
| `--proxy hearth`         | No ports opened; the Relay connects to Hearth.                 |
| `--relay-host <address>` | The address Hearth reaches the Relay at, such as a domain.     |
| `--sftp-port <port>`     | The host port for SFTP, when 2022 is taken.                    |

If a port it needs is taken, the installer names what has it and stops. Its log
is `~/kiln-install.log`.

## Pair with a link

For a running Relay that Hearth can reach:

1. On its machine, run `docker exec kiln-relay kiln-relay pair create`.
2. In **Add Relay**, open **Pairing link**, paste the link, and choose **Review
   pairing**.
3. Check the **Relay fingerprint** and **Control endpoint**, and choose
   **Confirm and pair**.

The link lasts 15 minutes. For a Relay Hearth already knows, choose **Repair
connection**; its game servers and access stay attached.

A Relay from another Kiln installation asks whether to **Keep** its installation
ID or **Use this Kiln's**. The ID decides whose backups it finds.

## Pairing errors

- **Hearth can't reach the Relay:** use the **Install** tab, or forward the port.
- **Hearth can't find** the address: fix its DNS record.
- **Another Relay uses this address:** remove the old Relay in Hearth.
- **`join expired`:** choose **New command**.
- **Relay too old to join:** update it, or pair with a link.

### Hostname TLS is untrusted

The certificate is self-signed, expired, or for another name. Point DNS at the
Relay, or fix the certificate on the proxy in front of it.

### TLS handshake failed

A proxy in front of the Relay has no certificate for this name. Check its TLS
settings for the Relay's hostname.

### Cloudflare errors 525 and 526

Cloudflare couldn't make a trusted TLS connection to the Relay. Set the record to
DNS only, or give the Relay a certificate your Cloudflare SSL mode accepts.

### Relay URL redirected

A proxy answered with a redirect, such as HTTP to HTTPS. Fix its SSL settings so
the address reaches the Relay over HTTPS.
