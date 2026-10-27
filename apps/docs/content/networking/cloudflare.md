---
title: Cloudflare
description: Connect a Cloudflare API token so Kiln creates a vanity address, like play.example.com, for each game server.
---

With a Cloudflare API token, Kiln gives game servers addresses under your own
domains, such as `emerald.example.com`, and keeps their DNS records in line as
they move. Players join with the name instead of the Relay's IP address.

Cloudflare vanity addresses are for game servers. For an app's domain, point
DNS at its Relay yourself; see [Domains and HTTPS](/apps/domains).

Only platform administrators can see **Domains** and set this up.

## Create a token

1. In Hearth, open **Domains**, under Infrastructure, and choose **Configure
   vanity**.
2. Choose **Create token** to open Cloudflare's API tokens page, and create a
   custom token with two permissions:
   - **DNS**: Edit
   - **Zone**: Read
3. Under zone resources, add every domain Kiln should use, or all zones.

To see the policy as Cloudflare shows it, choose the question-mark button
beside **Cloudflare API token**, **Preview required permissions**.

Kiln encrypts the token, never sends it back to the browser, and keeps every
record it manages **DNS only**, not proxied.

## Connect it

1. Paste the token into **Cloudflare API token**. Kiln lists the domains it can
   manage.
2. Check the domains Kiln may use, and choose the **Default**.
3. Optionally, turn on **Automatic provisioning** and choose how new game
   servers get a domain:
   - **Default only** uses the default domain.
   - **Random** picks one of the checked domains.
   - **Spread evenly** picks the one with the fewest game servers.
4. Optionally, list **Blacklisted vanity names**, one case-insensitive regular
   expression per line, such as `^(admin|api|www)$`.
5. Choose **Verify & save**. Later changes that keep the saved token use
   **Save configuration**.

The **Vanity** card on **Domains** then shows the settings and the domains in
use.

If you uncheck a domain that game servers already use, it shows **Existing
only**: their addresses keep working, but new game servers won't get it.

## What Kiln creates

For each game server's vanity address, Kiln creates, in that domain's zone:

- an `A`, `AAAA`, or `CNAME` record for `name.example.com`, pointing at the
  game server's Relay;
- an `SRV` record pointing at the game server's port, when its Brick supports
  one, as Minecraft does.

With the `SRV` record, players join with `name.example.com` alone. Without it,
they add the port.

## Give a game server an address

With **Automatic provisioning** on, a game server without an address gets one
when it starts, or when you choose **Sync managed domains**. To add one
yourself:

1. On **Domains**, choose **New domain**.
2. Choose the **Game server**.
3. Enter a **Vanity name**, or leave it blank and Kiln picks an available one.
   With more than one domain, choose which one.
4. Choose **Create domain**.

A game server's first address becomes its connect address, the one its pages
show. For another, turn on **Use as connect address** to show it instead.

Each address shows its status, such as **Active**, **Pending**, or **Error**.
Choose **Edit** on a row to rename the address, or **Delete** to remove it and
its records. A game server whose last address you delete isn't given a new one
automatically.

## Keep records in line

When a game server's Relay address or port changes, Kiln updates its records
the next time the game server starts or its ports change. To bring every game
server's records in line at once, and retry ones that failed, choose **Sync
managed domains** on **Domains**.
