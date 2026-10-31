---
title: Networking
description: Open the ports Kiln uses, give game servers addresses under your domain with Cloudflare, and reach instances privately over Tailscale.
---

## Ports

Kiln publishes ports on the Relay's machine but doesn't change any firewall or
router. Allow these inbound yourself:

| What | Ports |
| --- | --- |
| Game servers | `30000`–`39999` TCP and UDP, or only the ones in use |
| Bundled Traefik, for [app domains](/apps/domains) | `80` and `443` TCP |
| SFTP, for game server files | `2022` TCP by default |
| [App published ports](/apps/settings#published-ports) | Any you set |
| Databases | None |

Each game server's main port, **Default Server**, gets a public port from the
Relay's range. Set `KILN_RELAY_GAME_PORT_RANGE` on the Relay to change it. To
add another, such as for voice chat, choose **Add port** under **Ports** on
the game server's **Network** page, with a **Name**, **Internal Port**, and
**Protocol**. Kiln fills in a free **Public Port**. A game server can have up
to 16 ports.

## Cloudflare

With a Cloudflare API token, Kiln gives game servers addresses such as
`emerald.example.com` and keeps their DNS records current as they move. Only
platform administrators can set it up.

1. Open **Domains**, under Infrastructure, and choose **Configure vanity**.
2. Choose **Create token** and create a Cloudflare token with **DNS**: Edit
   and **Zone**: Read, for the domains Kiln should use.
3. Paste it into **Cloudflare API token**, check the domains, and choose the
   **Default**.
4. Optionally, turn on **Automatic provisioning** so new game servers get an
   address when they start.
5. Choose **Verify & save**.

Kiln creates a DNS-only `A`, `AAAA`, or `CNAME` record for each address, and an
`SRV` record when the Brick supports one, as Minecraft does, so players can
leave off the port. To add one by hand, choose **New domain** on **Domains**.
**Sync managed domains** brings every record in line and retries failures.

## Tailscale

Kiln can put game servers and app services on your Tailscale tailnet, where
devices signed in reach each at a private name, such as `survival.kiln`. No
public port is needed. Only platform administrators can set it up.

1. In Tailscale, add a tag for Kiln, such as `tag:kiln`, to your tailnet
   policy.
2. In Hearth, open **Tailscale**, under Infrastructure, choose **Setup
   Tailscale**, then **Create OAuth Credential**.
3. Give it **Write** access to **General** / **DNS**, **Devices** / **Core**,
   **Devices** / **Routes**, and **Keys** / **Auth Keys**, with your tag on
   **Devices** / **Core** and **Keys** / **Auth Keys**.
4. Back in Hearth, enter a **Network name**, the **Private domain**, such as
   `kiln`, the client ID and secret, and the **Device tag**. Choose **Validate
   and connect**.

Then choose **Connect Game Servers**, or **Join** under **Tailscale networks**
on a game server's or app's **Network** page. Deploy an app once before it can
join. The first one on a Relay sets Tailscale up there; it moves from
**Provisioning** to **Connected**. **Disconnect** removes it.
