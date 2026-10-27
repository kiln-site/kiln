---
title: Ports
description: Which ports game servers, apps, and Traefik use on a Relay's machine, how Kiln assigns them, and what to open in your firewall.
---

Kiln publishes ports on a Relay's machine for game servers, for apps that ask
for them, and for Traefik. It doesn't change the machine's firewall, your
cloud provider's firewall, or your router. Open the ports there yourself.

## What uses which ports

| What | Ports | Who picks them |
| --- | --- | --- |
| Game servers | One or more each, from `30000`–`39999` by default | Kiln |
| Apps' published ports | Any you set | You |
| Bundled Traefik, for app domains | `80` and `443` | Fixed |
| SFTP, for game server files | `2022` by default | The Relay's settings |
| Databases | None | — |

The Relay's own connection to Hearth may use a port too; see
[Add a Relay](/relays/add).

## Game server ports

Each game server's main port, its **Default Server**, gets a public port of its
own from the Relay's range, `30000`–`39999` unless the Relay sets
`KILN_RELAY_GAME_PORT_RANGE`. Its address is the Relay's address and that
port, such as `203.0.113.10:31234`.

To publish another port, such as one for voice chat or a web map:

1. Open the game server's **Network** page. Under **Ports**, choose **Add
   port**.
2. Enter a **Name**, and the **Internal Port** the game listens on inside its
   container.
3. Choose the **Protocol**: **TCP**, **UDP**, or **TCP + UDP**.
4. Kiln fills in a free **Public Port**. If you're allowed to choose one, you
   can change it to another free port inside the Relay's range.
5. Choose **Add port**.

A game server can have up to 16 ports. A change to the **Default Server**
applies when you restart the game server; Hearth tells you when a restart is
needed.

To give a game server a name instead of an address and port, see
[Cloudflare](/networking/cloudflare).

## App ports

An app publishes no ports unless you add them under **Published ports** on its
**Network** page, or its Compose file lists them. You choose the host port. See
[Published ports](/apps/settings#published-ports).

For websites, use a web route instead: Traefik serves every app's domains on
ports `80` and `443`. See [Domains and HTTPS](/apps/domains).

## Databases

Databases publish no ports. Only game servers and apps on the same Relay that
you connect can reach them. See [Connect to a database](/databases/connect).

## Open your firewall

On the machine, and in any cloud firewall or router in front of it, allow
inbound:

- the game server range, `30000`–`39999` TCP and UDP, or only the ports your
  game servers use;
- `80` and `443` TCP, if the Relay runs Bundled Traefik;
- `2022` TCP, if people use SFTP;
- any ports your apps publish.

> [!TIP]
> A machine behind a router you can't forward ports through can still join
> Kiln, but players and browsers can't reach its game servers or websites.
> To reach them privately instead, see [Tailscale](/networking/tailscale).
