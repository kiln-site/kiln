---
title: Add a Relay
description: Run the command Hearth gives you on a new machine, confirm the Relay, and fix pairing errors.
---

To run game servers, apps, or databases on another machine, add a Relay to it.
Hearth gives you one command to run there. It installs Docker if it's missing,
starts the Relay, and connects it to your Kiln.

Adding Relays needs the **Kiln Admin** or **Relay Creator** platform role.

## Add a machine

1. In Hearth, open **Infrastructure → Relays** and choose **Add Relay**.
2. On the **Install** tab, choose **Copy** to copy the command.
3. Run it on the new machine:

   ```sh title="On the new machine"
   curl -fsSL https://kiln.site/install | sh -s -- --join 'https://kiln.example.com/#kj1.<code>'
   ```

4. Wait for the dialog to show the new Relay, with its address, version, and
   fingerprint. The installer prints the same fingerprint, and a link that
   opens this dialog on the Relay, so you can confirm it from any browser.
5. Check the fingerprint matches, enter a **Name** if you want one, and choose
   **Add Relay**.

Hearth opens the new Relay's **Info** page once it's added. Left blank, the name
is the next free default, such as K100, then K101.

The command works for 30 minutes. The dialog counts down, and **New command**
makes a fresh one and retires the old.

> [!NOTE]
> When Hearth's address is plain HTTP, the dialog asks before it shows the
> command. Someone on the network between the two machines could interfere
> with the pairing, so use HTTPS when you can.

### How the installer reaches the Relay

The machine must be able to reach Hearth at its address. Hearth doesn't need to
reach the machine. The installer picks how the Relay is reached:

- **Ports 80 and 443 are free:** the Relay runs its own Traefik on them and
  gets a Let's Encrypt certificate for the machine's public address. Apps on
  that machine get their domains and HTTPS from the same Traefik.
- **Something else has port 80 or 443:** the Relay listens on port 4100 with a
  certificate of its own.
- **Let's Encrypt can't reach the machine on port 80,** as behind a home router:
  the Relay opens no ports and connects to Hearth itself. Its consoles and file
  transfers go through Hearth. See [Connections](/relays/connections).

To choose yourself, add an option to the command:

| Option                    | What it does                                                         |
| ------------------------- | -------------------------------------------------------------------- |
| `--proxy traefik`         | Traefik on ports 80 and 443, with a Let's Encrypt certificate.       |
| `--proxy none`            | The Relay's own HTTPS on port 4100.                                  |
| `--proxy hearth`          | No ports opened; the Relay connects to Hearth.                       |
| `--relay-host <address>`  | The address Hearth reaches the Relay at, such as a domain name.      |
| `--sftp-port <port>`      | The host port for SFTP, when 2022 is taken.                          |

The installer stops before it starts anything when a port it needs is taken, and
names what has it. Its full output goes to `~/kiln-install.log`.

### A machine that already runs a Relay

Running the command on a machine that already has a Relay joins that Relay
instead of installing a new one. If Hearth already has it, the dialog says so
and offers **Reconnect**, which keeps its game servers, apps, and databases.

## Pair with a link

Use the **Pairing link** tab for a Relay that's already running and that Hearth
can reach.

1. On the Relay's machine, print a pairing link:

   ```sh title="On the Relay's machine"
   docker exec kiln-relay kiln-relay pair create
   ```

2. In **Add Relay**, open **Pairing link**, paste the link, and choose
   **Review pairing**.
3. Check the **Relay fingerprint** and **Control endpoint**, then choose
   **Confirm and pair**.

The link expires after 15 minutes. If Hearth already knows the Relay, the button
reads **Repair connection**: Hearth repairs it in place, and its game servers, file
activity, pins, and access stay attached.

## Installation IDs

A Relay takes the installation ID of the first Kiln that pairs it. When you add
a Relay that already belongs to another Kiln installation, the dialog asks
whether to **Keep** its ID or **Use this Kiln's**. The ID decides whose Kiln
services and backups the Relay finds. It doesn't limit anything else: every
Hearth paired with full access can manage the Relay.

## Pairing errors

When adding a Relay fails, the dialog says why. Find the message below.

### Hearth can't reach the Relay

> Hearth can't reach the Relay at `<host>:<port>`. If its machine is behind a
> router, forward port `<port>` to it.

Nothing answered at the Relay's address: the Relay isn't running, a firewall
blocks the port, or a router doesn't forward it.

- Use the **Install** tab. A Relay added with the install command connects to
  Hearth itself, so Hearth never needs to reach it.
- Or forward the port from the router to the machine, and open it in any
  firewall.

### Hearth can't find the address

> Hearth can't find `<host>`. Check that its DNS points at the Relay's machine.

The Relay's hostname doesn't resolve from Hearth. Check the DNS record, or wait
for a new record to spread.

### Hostname TLS is untrusted

> Hostname TLS is untrusted. Check that DNS points at your Relay.

The certificate at the Relay's address isn't one Hearth trusts: it's
self-signed, expired, or for another name. This usually means the hostname
points at another machine or proxy. Point DNS at the Relay's machine, or fix the
certificate on the proxy in front of it.

### TLS handshake failed

> TLS handshake failed for this hostname.

Something answered at the address but couldn't agree on TLS with Hearth, as when
a proxy in front of the Relay has no certificate for that name. Check the proxy's
TLS settings for the Relay's hostname.

### Cloudflare errors 525 and 526

> Cloudflare rejected the origin certificate (526).

> Cloudflare could not complete the TLS handshake with the origin (525).

The hostname goes through Cloudflare's proxy, and Cloudflare couldn't make a
trusted TLS connection to the Relay. Either turn off Cloudflare's proxy for the
Relay's hostname, so the record is DNS only, or give the origin a certificate
Cloudflare accepts for its SSL mode.

### Relay URL redirected

> Relay URL redirected instead of pairing. Check reverse-proxy SSL settings.

A proxy in front of the Relay answered with a redirect, such as HTTP to HTTPS,
instead of passing the request on. Check the proxy's SSL settings, so the
Relay's address reaches the Relay directly over HTTPS.

### Another Relay uses this address

When the dialog says another Relay already uses the address, the machine was
probably set up again. Remove the old Relay in Hearth to add this one in its
place; the dialog updates once it's gone.

### The command expired

The installer stops with `join expired` when the command is older than 30
minutes. Choose **New command** in the dialog and run the new one.

### The Relay is too old to join

When the installer says the Relay is older than joining needs, update the Relay,
or pair it with a link: run `kiln-relay pair create` on it and paste the result
into the **Pairing link** tab.
